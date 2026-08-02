import { createServer } from 'node:http';

const port = Number(process.env.PORT || 8091);
const serviceName = process.env.SERVICE_NAME || 'node-hello';

createServer((request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (request.url === '/health') {
    response.end(JSON.stringify({ status: 'ok', service: serviceName }));
    return;
  }
  response.end(JSON.stringify({ message: `Hello from ${serviceName}`, runtime: 'node' }));
}).listen(port, '0.0.0.0', () => console.log(`${serviceName} listening on :${port}`));
