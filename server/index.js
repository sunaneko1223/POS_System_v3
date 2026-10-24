"use strict";

const express = require("express");
const helmet = require("helmet");
const { loadConfig } = require("./config");
const db = require("./db");
const auth = require("./auth");
const { createLimiters } = require("./middleware/rateLimit");
const { notFound, errorHandler } = require("./middleware/error");
const { createAuthRouter } = require("./routes/auth");
const { createPublicRouter } = require("./routes/public");
const { createCafeRouter } = require("./routes/cafe");
const { createPosRouter } = require("./routes/pos");
const { createAdminRouter } = require("./routes/admin");
const { attachWebSocket } = require("./ws");

const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// データベースが眠っていて、起こすのに時間がかかる場合に備えて、数回やり直す
async function withRetry(fn, tries, waitMs) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries) throw err;
      console.warn(
        `[起動] DB初期化に失敗(${i}/${tries}回目): ${err.message}。${waitMs / 1000}秒後に再試行します`,
      );
      await sleep(waitMs);
    }
  }
}

async function main() {
  const config = loadConfig();
  auth.initAuth(config);
  await withRetry(() => db.initDb(config), 5, 3000);

  const app = express();
  app.disable("x-powered-by");

  // クライアントのIPを正しく取るための設定。値(プロキシの段数)は環境変数 TRUST_PROXY で指定します。
  // 段数が分からないときは、DEBUG_IP=1 にして /debug/ip で確かめてください(README参照)。
  const tp = process.env.TRUST_PROXY;
  if (tp !== undefined && tp !== "") {
    app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp);
  } else {
    console.warn(
      "[起動] TRUST_PROXY が未設定です。全員が同じIPとして扱われ、ロックや回数制限が全員に効く恐れがあります",
    );
  }

  // 画面は、外部のスクリプト・画像を使わない。WebSocket は、自分のサイトにだけつなぐ。
  const connectSrc = ["'self'"];
  if (process.env.PUBLIC_BASE_URL) {
    try {
      const u = new URL(process.env.PUBLIC_BASE_URL);
      connectSrc.push(`${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`);
    } catch (e) {
      console.warn("[起動] PUBLIC_BASE_URL の形式が正しくありません");
    }
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "connect-src": connectSrc,
          "upgrade-insecure-requests": null,
        },
      },
    }),
  );
  app.use(express.json({ limit: "10kb", inflate: false })); // 圧縮されたリクエストは受け付けない(脆弱性の対策)

  const { pingLimiter, apiLimiter, loginLimiter } = createLimiters(
    config.security.api_limit_per_min,
  );

  // GAS などから定期的に叩く生存確認用。DBも認証も使いません。
  app.get("/ping", pingLimiter, (req, res) => {
    res.type("text/plain").send("ok");
  });

  // IPの取り方の確認用。DEBUG_IP=1 のときだけ有効。確認が終わったら環境変数を消してください。
  if (process.env.DEBUG_IP === "1") {
    console.warn(
      "[起動] DEBUG_IP=1: /debug/ip が有効です。確認後は必ず無効にしてください",
    );
    app.get("/debug/ip", (req, res) => {
      res.json({
        ip: req.ip,
        xForwardedFor: req.headers["x-forwarded-for"] || null,
        envTrustProxy:
          process.env.TRUST_PROXY === undefined
            ? null
            : process.env.TRUST_PROXY, // Secretsから読んだ値
        trustProxyInUse: app.get("trust proxy"), // サーバーが実際に使っている設定
      });
    });
  }

  // APIの返事は、ブラウザや中継サーバーに保存させない(識別番号ごとに内容が違うため)
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", apiLimiter);
  app.use("/api", createAuthRouter(loginLimiter));
  app.use("/api/public", createPublicRouter(config));
  app.use("/api/cafe", auth.requireRole("cafe", "admin"), createCafeRouter(config));
  app.use("/api/pos", auth.requireRole("pos", "admin"), createPosRouter(config));
  app.use("/api/admin", auth.requireRole("admin"), createAdminRouter());

  // 画面(HTML・JS)と、ビルドしたCSS
  const webDir = path.join(__dirname, "..", "web");
  app.use("/assets", express.static(path.join(webDir, "dist")));
  app.use("/shared", express.static(path.join(webDir, "shared")));
  for (const site of ["public", "pos", "cafe", "admin", "Manual"]) {
    app.use("/" + site, express.static(path.join(webDir, site)));
  }

  app.use(notFound);
  app.use(errorHandler);

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(
      `[起動] ${config.event.name} サーバーを起動しました (port ${port})`,
    );
  });
  const wsApi = attachWebSocket(server);

  const shutdown = async (signal) => {
    console.log(`[終了] ${signal} を受け取りました`);
    wsApi.close();
    server.close(async () => {
      await db.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[起動] 失敗しました:", err.message);
  process.exit(1);
});
