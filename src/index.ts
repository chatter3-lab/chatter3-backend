// src/index.ts
export interface Env {
  DB: D1Database;
  CHATTER3_KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Basic CORS setup for frontend API calls
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response("OK", { headers });
    }

    if (url.pathname === "/api/health") {
      return new Response(
        JSON.stringify({ status: "ok", timestamp: Date.now() }),
        { headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/api/points" && request.method === "POST") {
      const body = await request.json<{ userId: string; points: number }>();

      // Store point transaction
      await env.DB.prepare(
        `INSERT INTO points (user_id, points, created_at) VALUES (?, ?, ?)`
      )
        .bind(body.userId, body.points, Date.now())
        .run();

      // Also cache total in KV
      const key = `points:${body.userId}`;
      const existing = (await env.CHATTER3_KV.get(key)) || "0";
      const total = parseInt(existing) + body.points;
      await env.CHATTER3_KV.put(key, total.toString());

      return new Response(
        JSON.stringify({ message: "Points added", total }),
        { headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404, headers });
  },
};
