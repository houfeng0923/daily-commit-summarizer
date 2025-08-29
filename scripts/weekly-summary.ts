// scripts/weekly-summary.ts
// 运行前：确保在 GitHub Actions 或本地 shell 中已设置：
//   - OPENAI_API_KEY：LLM 密钥（可替换为企业网关）
//   - OPENAI_BASE_URL：LLM API 地址（可替换为自建网关）
//   - LARK_WEBHOOK_URL：飞书自定义机器人 Webhook （也可替换为其他通知 Webhook ）
// 可选：
//   - PER_BRANCH_LIMIT：每个分支最多统计的“本周提交”条数（默认 200）
//   - DIFF_CHUNK_MAX_CHARS：单次送模的最大字符数（默认 80000）
//   - MODEL_NAME：指定模型名称（默认 gpt-4.1-mini）
//   - REPO：owner/repo（Actions 内自动注入）

import { execSync } from "node:child_process";
import https from "node:https";

// ------- 环境变量 -------
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://models.github.ai/";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const LARK_WEBHOOK_URL = process.env.LARK_WEBHOOK_URL || "";
const REPO = process.env.REPO || ""; // e.g. "org/repo"
const MODEL_NAME = process.env.MODEL_NAME || "openai/gpt-4.1-mini";
const PER_BRANCH_LIMIT = parseInt(process.env.PER_BRANCH_LIMIT || "200", 10);
const DIFF_CHUNK_MAX_CHARS = parseInt(
  process.env.DIFF_CHUNK_MAX_CHARS || "80000",
  10,
);

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

// 统一时区为美西（影响 Date 与 git 相对时间解析）
process.env.TZ = process.env.TZ || "America/Los_Angeles";

// ------- 工具函数 -------
function sh(cmd: string) {
  return execSync(cmd, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function safeArray<T>(xs: T[] | undefined | null) {
  return Array.isArray(xs) ? xs : [];
}

function formatDateInLA(d: Date) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function formatDateTimeLocal(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// ------- 分支与提交收集（覆盖 origin/* 全分支）-------
// 周期：本周（周一 00:00:00 ~ 周日 23:59:59，受 TZ=America/Los_Angeles 影响）
const nowLocal = new Date();
const endOfWeek = new Date(nowLocal);
endOfWeek.setHours(23, 59, 59, 999);
// 计算周一：JS 周日=0，周一=1
const startOfWeek = new Date(nowLocal);
startOfWeek.setHours(0, 0, 0, 0);
const day = startOfWeek.getDay();
const offsetToMonday = (day + 6) % 7; // 周一=0，周日=6
startOfWeek.setDate(startOfWeek.getDate() - offsetToMonday);
// 将结束日定位到本周周日 23:59:59
const sunday = new Date(startOfWeek);
sunday.setDate(sunday.getDate() + 6);
sunday.setHours(23, 59, 59, 999);

const since = formatDateTimeLocal(startOfWeek);
const until = formatDateTimeLocal(sunday);

// 拉全远端（建议在 workflow 里执行：git fetch --all --prune --tags）
// 这里再次保险 fetch 一次，避免本地调试遗漏
try {
  sh(`git fetch --all --prune --tags`);
} catch {
  // ignore
}

// 列出所有 origin/* 远端分支，排除 origin/HEAD
const remoteBranches = sh(
  `git for-each-ref --format="%(refname:short)" refs/remotes/origin | grep -v "^origin/HEAD$" || true`,
)
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

// 分支白名单/黑名单（如需）：在此可用正则筛选 remoteBranches

type CommitMeta = {
  sha: string;
  title: string;
  author: string;
  url: string;
  branches: string[]; // 该提交归属的分支集合
};

const branchToCommits = new Map<string, string[]>();
for (const rb of remoteBranches) {
  const list = sh(
    `git log ${rb} --no-merges --since="${since}" --until="${until}" --pretty=format:%H --reverse || true`,
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  branchToCommits.set(rb, list.slice(-PER_BRANCH_LIMIT));
}

// 反向映射：提交 → 出现的分支集合
const shaToBranches = new Map<string, Set<string>>();
for (const [rb, shas] of branchToCommits) {
  for (const sha of shas) {
    if (!shaToBranches.has(sha)) shaToBranches.set(sha, new Set());
    shaToBranches.get(sha)!.add(rb);
  }
}

// 在所有分支联合视图中获取本周提交，按时间从早到晚，再与 shaToBranches 交集过滤
const allShasOrdered = sh(
  `git log --no-merges --since="${since}" --until="${until}" --all --pretty=format:%H --reverse || true`,
)
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const seen = new Set<string>();
const commitShas = allShasOrdered.filter((sha) => {
  if (seen.has(sha)) return false;
  if (!shaToBranches.has(sha)) return false; // 仅统计出现在 origin/* 的提交
  seen.add(sha);
  return true;
});

if (commitShas.length === 0) {
  console.log("📭 本周所有分支均无有效提交。结束。");
  process.exit(0);
}

const serverUrl = "https://github.com";

const commitMetas: CommitMeta[] = commitShas.map((sha) => {
  const title = sh(`git show -s --format=%s ${sha}`);
  const author = sh(`git show -s --format=%an ${sha}`);
  const url = REPO
    ? `${serverUrl}/${REPO}/commit/${sha}`
    : `${serverUrl}/commit/${sha}`;
  const branches = Array.from(shaToBranches.get(sha) || []).sort();
  return { sha, title, author, url, branches };
});

// ------- diff 获取与分片 -------
const FILE_EXCLUDES = [
  ":!**/*.lock",
  ":!**/dist/**",
  ":!**/build/**",
  ":!**/.next/**",
  ":!**/.vite/**",
  ":!**/out/**",
  ":!**/coverage/**",
  ":!package-lock.json",
  ":!pnpm-lock.yaml",
  ":!yarn.lock",
  ":!**/*.min.*",
];

function getParentSha(sha: string) {
  const line = sh(`git rev-list --parents -n 1 ${sha} || true`);
  const parts = line.split(" ").filter(Boolean);
  // 非 merge 情况 parent 通常只有一个；root commit 无 parent
  return parts[1];
}

function getDiff(sha: string) {
  const parent = getParentSha(sha);
  const base = parent || sh(`git hash-object -t tree /dev/null`);
  const excludes = FILE_EXCLUDES.join(" ");
  const diff = sh(
    `git diff --unified=0 --minimal ${base} ${sha} -- . ${excludes} || true`,
  );
  return diff;
}

function splitPatchByFile(patch: string): string[] {
  if (!patch) return [];
  const parts = patch.split(/^diff --git.*$/m);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function chunkBySize(parts: string[], limit = DIFF_CHUNK_MAX_CHARS): string[] {
  const out: string[] = [];
  let buf = "";
  for (const p of parts) {
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (candidate.length > limit) {
      if (buf) out.push(buf);
      if (p.length > limit) {
        for (let i = 0; i < p.length; i += limit) {
          out.push(p.slice(i, i + limit));
        }
        buf = "";
      } else {
        buf = p;
      }
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ------- OpenAI Chat API -------
type ChatPayload = {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
};

async function chat(prompt: string): Promise<string> {
  const payload: ChatPayload = {
    model: MODEL_NAME,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  };
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const url = new URL(OPENAI_BASE_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: `/openai/deployments/${MODEL_NAME}/chat/completions?api-version=2024-12-01-preview`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try {
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
              const json = JSON.parse(data);
              const content =
                json?.choices?.[0]?.message?.content?.trim() || "";
              resolve(content);
            } else {
              reject(new Error(`OpenAI HTTP ${res.statusCode}: ${data}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ------- 提示词 -------
function commitChunkPrompt(
  meta: CommitMeta,
  partIdx: number,
  total: number,
  patch: string,
) {
  return `你是一名高效的个人知识管理助手。以下是“个人笔记”内容片段（第 ${partIdx}/${total} 段），请用中文输出结构化摘要，面向读书笔记、待办任务、闪念想法、生活/健身/教育等场景：

记录信息：
- 记录ID: ${meta.sha}
- 标题: ${meta.title}
- 作者: ${meta.author}
- 关联分支/主题: ${meta.branches.join(", ")}
- 链接: ${meta.url}

请按以下结构输出（尽量简洁、要点化）：
1) 内容类型识别：如 读书笔记 / 待办 / 闪念 / 生活 / 健身 / 教育 / 其他
2) 核心要点：3-6 条，概括事实、观点或步骤
3) 可执行事项：列出需要行动的任务（含优先级与预估时间）
4) 后续计划与提醒：下一步、时间节点、依赖或阻塞
5) 反思与启发：个人理解、方法论、可迁移的框架
6) 标签与归档建议：话题标签（#tag），以及应归档到的目录/项目

注意：仅基于当前片段，不要臆测；不要贴长原文；若为重复、格式化或噪声内容，请明确指出并给出处理建议（合并/删除/延期/归档）。

=== 内容片段 BEGIN ===
${patch}
=== 内容片段 END ===`;
}

function commitMergePrompt(meta: CommitMeta, parts: string[]) {
  const joined = parts.map((p, i) => `【片段${i + 1}】\n${p}`).join("\n\n");
  return `以下是同一笔“个人笔记”在多片段中的小结，请合并为**单条记录**的最终摘要（中文），面向读书笔记、待办、闪念、生活/健身/教育等场景，输出结构：
- 内容类型汇总：从各片段判断主类型与可能的次类型
- 合并的核心要点：3-8 条，去重与合并同类项
- 可执行行动清单：任务+优先级（高/中/低）+预估时间（分钟/小时/天）
- 时间线与提醒：截止/开始时间、周期性、依赖与阻塞
- 关键引用/摘录：用极简要点形式保留核心引用（不贴长段原文）
- 反思与启发：个人方法论、可迁移框架或原则
- 标签与归档建议：#标签，推荐目录/项目
- 完整性标注：若片段缺失或被截断，标注“可能不完整”

记录元信息：
- 记录ID: ${meta.sha}
- 标题: ${meta.title}
- 作者: ${meta.author}
- 关联分支/主题: ${meta.branches.join(", ")}
- 链接: ${meta.url}

请避免重复、不要臆测，保持简洁清晰，突出可执行价值。

=== 片段小结集合 BEGIN ===
${joined}
=== 片段小结集合 END ===`;
}

function weeklyMergePrompt(
  weekLabel: string,
  items: { meta: CommitMeta; summary: string }[],
  repo: string,
) {
  const body = items
    .map(
      (it) =>
        `[${it.meta.sha.slice(0, 7)}] ${it.meta.title} — ${it.meta.author} — ${it.meta.branches.join(", ")}
${it.summary}`,
    )
    .join("\n\n---\n\n");

  return `请将以下“本周个人笔记条目摘要”整合为**本周个人知识与行动周报（中文）**，面向读书笔记、待办、闪念、生活/健身/教育等场景，输出结构如下：
# ${weekLabel} 个人知识与行动周报（${repo})
1. 本周概览（3-8 条，主题与收获）
2. 关键洞见与知识要点（按主题/标签分组，合并同类项）
3. 可执行行动清单（下周优先）：任务 + 优先级 + 预估时间
4. 时间线与提醒（截止/开始/周期性），标注依赖与阻塞
5. 读书/学习进展（书名/章节/方法论/可迁移框架）
6. 生活与健康（健身/饮食/作息）数据化小结与下步计划
7. 闪念收纳与归档建议（去重、合并、落盘到项目/目录）
8. 清理建议（重复/噪声/仅格式化），以及归档或删除决策

注意：
- 避免臆测与冗长引用，突出要点与行动价值
- 标注“可能不完整”当来源片段缺失或被截断
- 给出标签建议（#标签）与归档位置（目录/项目）

=== 本周条目摘要 BEGIN ===
${body}
=== 本周条目摘要 END ===`;
}

// ------- 飞书 Webhook -------
async function postToLark(text: string) {
  if (!LARK_WEBHOOK_URL) {
    console.log("LARK_WEBHOOK_URL 未配置，以下为最终周报文本：\n\n" + text);
    return;
  }
  const payload = JSON.stringify({ msg_type: "text", content: { text } });
  await new Promise<void>((resolve, reject) => {
    const url = new URL(LARK_WEBHOOK_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ------- 主流程 -------
(async () => {
  const perCommitFinal: { meta: CommitMeta; summary: string }[] = [];

  for (const meta of commitMetas) {
    const fullPatch = getDiff(meta.sha);

    if (!fullPatch || !fullPatch.trim()) {
      perCommitFinal.push({
        meta,
        summary: `（无有效内容或改动已被过滤，例如 lockfile/构建产物/二进制，或空提交）`,
      });
      continue;
    }

    const fileParts = splitPatchByFile(fullPatch);
    const chunks = chunkBySize(fileParts, DIFF_CHUNK_MAX_CHARS);

    const partSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const prompt = commitChunkPrompt(meta, i + 1, chunks.length, chunks[i]);
      try {
        const sum = await chat(prompt);
        partSummaries.push(sum || `（片段${i + 1}摘要为空）`);
      } catch (e: any) {
        partSummaries.push(`（片段${i + 1}调用失败：${String(e)}）`);
      }
    }

    // 合并为“单记录摘要”
    let merged = "";
    try {
      merged = await chat(commitMergePrompt(meta, partSummaries));
    } catch (e: any) {
      merged = partSummaries.join("\n\n");
    }

    perCommitFinal.push({ meta, summary: merged });
  }

  // 本周日期标签 YYYY-MM-DD ~ YYYY-MM-DD（美西时区，周一~周日）
  const startLabel = formatDateInLA(startOfWeek);
  const endLabel = formatDateInLA(sunday);
  const weekLabel = `${startLabel} ~ ${endLabel}`;

  // 汇总“本周总览”
  let weekly = "";
  try {
    weekly = await chat(
      weeklyMergePrompt(weekLabel, perCommitFinal, REPO || "repository"),
    );
  } catch (e: any) {
    weekly =
      `（本周汇总失败，以下为逐条原始小结拼接）\n\n` +
      perCommitFinal
        .map(
          (it) =>
            `[${it.meta.sha.slice(0, 7)}] ${it.meta.title} — ${it.meta.branches.join(", ")}\n${it.summary}`,
        )
        .join("\n\n---\n\n");
  }

  // 发送飞书
  await postToLark(weekly);
  console.log("✅ 已发送飞书周报。");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});


