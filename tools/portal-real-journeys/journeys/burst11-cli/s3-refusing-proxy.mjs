import http from "node:http";
import net from "node:net";
const PORT = 8899;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const upstream = http.request(req.url, { method: req.method, headers: { ...req.headers, host: new URL(req.url).host } }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
      const line = `${new Date().toISOString()} PASS ${req.method} ${req.url.slice(0, 110)} -> ${r.statusCode}\n`;
      process.stdout.write(line);
    });
    upstream.on("error", (e) => { try { res.writeHead(502); res.end(String(e)); } catch {} });
    upstream.end(body);
  });
});
server.on("connect", (req, socket, head) => {
  const host = (req.url || "").split(":")[0];
  const refused = host === "s3.amazonaws.com" || host.endsWith(".s3.amazonaws.com");
  const line = `${new Date().toISOString()} ${refused ? "REFUSE" : "PASS "} CONNECT ${req.url}\n`;
  process.stdout.write(line);
  if (refused) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nBlocked: s3 uploads are refused for this student-seat verification (a run that reports 'reported to hosted results' behind this proxy must be lying)\n");
    socket.destroy();
    return;
  }
  const [h, p] = (req.url || "").split(":");
  const up = net.connect(Number(p || 443), h, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
server.listen(PORT, "127.0.0.1", () => process.stdout.write(`${new Date().toISOString()} proxy listening on ${PORT}\n`));
