#!/usr/bin/env node
/**
 * A stand-in for the local decision-model server: answers /health and nothing else.
 * Used to test that the lifecycle starts something and can take it down again.
 *
 *   node scripts/fake-laya.mjs 8123
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8123);

const server = createServer((req, res) => {
	if (req.url?.startsWith("/health")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"status":"ok","loaded":["fake"]}');
		return;
	}
	res.writeHead(404, { "content-type": "application/json" });
	res.end('{"detail":"Not Found"}');
});

server.listen(port, "127.0.0.1", () => {
	console.log(`fake decision server listening on 127.0.0.1:${port}`);
});
