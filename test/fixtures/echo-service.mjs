// Tiny controllable HTTP service for tests. Usage: node echo-service.mjs <port> [delayMs]
import { createServer } from 'node:http';

const port = Number(process.argv[2]);
const delay = Number(process.argv[3] || 0);

function start() {
  createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200);
    res.end('echo');
  }).listen(port, '127.0.0.1', () => {
    console.log(`echo-service listening on ${port}`);
  });
}

if (delay > 0) setTimeout(start, delay);
else start();
