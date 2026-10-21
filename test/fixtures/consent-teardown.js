// AIT-364 owns an HTTP/SSE fixture, but its Chrome process is shared by the file.
export async function closeConsentFixture({ browser, server, streams }) {
  await browser.close();
  for (const stream of streams) stream.end();
  await new Promise(resolve => server.close(resolve));
}
