// Append to frozen 541a23a3 read-transport.test.ts. Injected parser/HTTP only; no helper launched.
test("REVIEW current authority is required before response parser admission after EOF await", async () => {
  let revoked = false, reads = 0, parserCalls = 0;
  const parser = { admission: "native-confined" as const, validate: async () => { parserCalls++; } };
  const http = async () => ({
    status: 200, redirected: false, url: "",
    headers: new Headers({"content-type":"application/x-git-upload-pack-advertisement"}),
    body: { getReader: () => ({
      read: async () => ++reads === 1 ? {done:false,value:advertisement} : (revoked=true,{done:true,value:undefined}),
      cancel: async () => {},
    }) },
  }) as unknown as Response;
  const t = new CoworkGitHubReadTransport({authorize:()=>({...grant,revoked})},{get:async()=>sentinel},http,{recheckMs:1000},{isolatedFixture:true,parser});
  await expect(t.read(caller, request)).rejects.toMatchObject({code:"authority_denied"});
  expect(parserCalls).toBe(0);
});
