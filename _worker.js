/**
 * myshopjiasu.pages.dev — 后端函数 _worker.js
 *
 * 通过 GitHub Contents API 管理图片仓库（相册 = 文件夹，图片 = 文件）
 *
 * 环境变量（在 Pages → Settings → Environment variables 中配置）：
 *   GITHUB_TOKEN   — GitHub Personal Access Token（需 repo 权限）【必填】
 *   GITHUB_OWNER   — 仓库 owner，默认 "lpmam"
 *   GITHUB_REPO    — 仓库名，默认 "amshop-photo"
 *   GITHUB_BRANCH  — 分支名，默认 "main"
 *
 * 接口：
 *   POST /upload          — 上传图片，multipart/form-data: image=<file>, folder=<string>, name=<可选>
 *   GET  /albums          — 获取所有相册（根目录文件夹）列表
 *   GET  /albums/{id}     — 获取某个相册内的图片列表
 *   GET  /folders         — 获取已有文件夹列表（仅返回名称）
 */

const GITHUB_API = "https://api.github.com";
const IMAGE_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".gif", ".webp",
  ".bmp", ".svg", ".ico", ".avif", ".tiff",
];

/* ── 工具函数 ─────────────────────────────────────────── */

function githubHeaders(env) {
  return {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "myshopjiasu-pages-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function repoInfo(env) {
  return {
    owner: env.GITHUB_OWNER || "lpmam",
    repo: env.GITHUB_REPO || "amshop-photo",
    branch: env.GITHUB_BRANCH || "main",
  };
}

/** 将路径按 / 拆分后逐段编码，保留 / 分隔符 */
function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

function isImageFile(name) {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

/** ArrayBuffer → base64（分块处理避免 call stack 溢出） */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ── 主入口 ───────────────────────────────────────────── */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS 预检
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 检查 Token
    if (!env.GITHUB_TOKEN) {
      return jsonResponse(
        { error: "GITHUB_TOKEN 环境变量未配置，请在 Pages Settings → Environment variables 中添加" },
        500
      );
    }

    const { owner, repo, branch } = repoInfo(env);
    const base = `${GITHUB_API}/repos/${owner}/${repo}`;

    try {
      /* ── POST /upload ── 上传图片 ── */
      if (path === "/upload" && method === "POST") {
        const formData = await request.formData();
        const image = formData.get("image");
        const folder = (formData.get("folder") || "uploads").toString().trim() || "uploads";
        const customName = formData.get("name")?.toString().trim();

        if (!image || typeof image === "string") {
          return jsonResponse({ error: '缺少 "image" 文件字段' }, 400);
        }

        // 读取文件 → base64
        const arrayBuffer = await image.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);

        // 生成文件名
        const originalName = image.name || "upload.jpg";
        const dotIdx = originalName.lastIndexOf(".");
        const ext = dotIdx > 0 ? originalName.substring(dotIdx) : "";
        const timestamp = Date.now();
        const random = Math.random().toString(36).slice(2, 6);
        const fileName = customName
          ? customName + (ext || ".jpg")
          : `${timestamp}_${random}${ext || ".jpg"}`;
        const filePath = `${folder}/${fileName}`;

        // 调用 GitHub Contents API 创建文件
        const ghResp = await fetch(
          `${base}/contents/${encodePath(filePath)}?ref=${branch}`,
          {
            method: "PUT",
            headers: githubHeaders(env),
            body: JSON.stringify({
              message: `Upload ${filePath}`,
              content: base64,
              branch,
            }),
          }
        );
        const ghData = await ghResp.json();

        if (!ghResp.ok) {
          return jsonResponse({ error: "GitHub API 错误", details: ghData }, ghResp.status);
        }

        const content = ghData.content || {};
        const pagesUrl = `https://${url.hostname}/${folder}/${fileName}`;
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${folder}/${fileName}`;

        return jsonResponse({
          success: true,
          file: fileName,
          folder,
          path: filePath,
          sha: content.sha,
          size: content.size,
          url: pagesUrl,        // Pages CDN 地址（部署后生效）
          raw_url: rawUrl,       // GitHub raw 地址（即时可用）
          download_url: content.download_url,
        });
      }

      /* ── GET /albums ── 获取所有相册列表 ── */
      if (path === "/albums" && method === "GET") {
        const ghResp = await fetch(`${base}/contents/?ref=${branch}`, {
          headers: githubHeaders(env),
        });
        const ghData = await ghResp.json();

        if (!ghResp.ok) {
          return jsonResponse({ error: "GitHub API 错误", details: ghData }, ghResp.status);
        }

        const albums = (Array.isArray(ghData) ? ghData : [])
          .filter((item) => item.type === "dir")
          .map((item) => ({
            id: item.name,
            name: item.name,
            path: item.path,
            url: `https://${url.hostname}/${item.name}`,
          }));

        return jsonResponse({ albums, count: albums.length });
      }

      /* ── GET /albums/{id} ── 获取某个相册的图片 ── */
      const albumMatch = path.match(/^\/albums\/(.+)$/);
      if (albumMatch && method === "GET") {
        const albumId = decodeURIComponent(albumMatch[1]);

        const ghResp = await fetch(
          `${base}/contents/${encodePath(albumId)}?ref=${branch}`,
          { headers: githubHeaders(env) }
        );
        const ghData = await ghResp.json();

        if (!ghResp.ok) {
          return jsonResponse({ error: "GitHub API 错误", details: ghData }, ghResp.status);
        }

        const images = (Array.isArray(ghData) ? ghData : [])
          .filter((item) => item.type === "file" && isImageFile(item.name))
          .map((item) => ({
            name: item.name,
            path: item.path,
            sha: item.sha,
            size: item.size,
            url: `https://${url.hostname}/${item.path}`,
            raw_url: item.download_url,
          }));

        return jsonResponse({ album: albumId, images, count: images.length });
      }

      /* ── GET /folders ── 获取已有文件夹列表 ── */
      if (path === "/folders" && method === "GET") {
        const ghResp = await fetch(`${base}/contents/?ref=${branch}`, {
          headers: githubHeaders(env),
        });
        const ghData = await ghResp.json();

        if (!ghResp.ok) {
          return jsonResponse({ error: "GitHub API 错误", details: ghData }, ghResp.status);
        }

        const folders = (Array.isArray(ghData) ? ghData : [])
          .filter((item) => item.type === "dir")
          .map((item) => item.name);

        return jsonResponse({ folders, count: folders.length });
      }

      /* ── 其他请求 → 回退到静态资源 ── */
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return jsonResponse({ error: "Not found", path }, 404);
    } catch (err) {
      return jsonResponse({ error: "内部错误", message: err.message }, 500);
    }
  },
};
