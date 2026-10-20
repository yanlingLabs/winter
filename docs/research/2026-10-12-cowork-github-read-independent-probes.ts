// Append to a242e538's read-authority.test.ts in a disposable frozen checkout.
// Reuses only that file's disposable setup and teardown. No external network.
test("REVIEW final scope await cannot authorize a stopped workspace", async () => {
  const f = setup();
  f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready");
  f.records.bindConversation({ principalId: "host", requestId: "bind", expectedRevision: 1 }, f.caller.workspaceId, { sessionId: "session", sourceId: f.source.sourceId });
  let calls = 0;
  f.resolver.sourceScope = async () => {
    if (++calls === 2) dbs[dbs.length - 1]!.db.query("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?").run(f.caller.workspaceId);
    return { revision: 1, sourceIds: [f.source.sourceId] };
  };
  await expect(f.readAuthority.authorize({ ...f.caller, sessionId: "session" }, f.request)).rejects.toMatchObject({ code: "authority_denied" });
});
test("REVIEW final transport recheck refuses stop during final scope await", async () => {
  const f = setup();
  f.records.acknowledgeSource(f.epoch, f.source.sourceId, f.source.revision, "ready");
  f.records.bindConversation({ principalId: "host", requestId: "bind", expectedRevision: 1 }, f.caller.workspaceId, { sessionId: "session", sourceId: f.source.sourceId });
  let scopeCalls = 0;
  f.resolver.sourceScope = async () => {
    if (++scopeCalls === 8) dbs[dbs.length - 1]!.db.query("UPDATE cowork_workspaces SET power='stopped' WHERE workspace_id=?").run(f.caller.workspaceId);
    return { revision: 1, sourceIds: [f.source.sourceId] };
  };
  const pkt = (s: string) => Buffer.from((Buffer.byteLength(s)+4).toString(16).padStart(4,"0")+s);
  const bytes = Buffer.concat([pkt("# service=git-upload-pack\n"),Buffer.from("0000"),pkt("1".repeat(40)+" HEAD\0multi_ack\n"),Buffer.from("0000")]);
  const transport = new CoworkGitHubReadTransport(f.readAuthority,{get:async()=>"fixture-only-token"},async()=>new Response(bytes,{headers:{"content-type":"application/x-git-upload-pack-advertisement"}}),{recheckMs:1000},{isolatedFixture:true});
  await expect(transport.read({ ...f.caller, sessionId: "session" }, f.request)).rejects.toMatchObject({code:"authority_denied"});
});
test("REVIEW upload body owns a snapshot even when caller supplies Buffer", async () => {
  const f = setup();
  const pkt = (s: string) => Buffer.from((Buffer.byteLength(s)+4).toString(16).padStart(4,"0")+s);
  const body = Buffer.concat([pkt("want "+"1".repeat(40)+"\n"),Buffer.from("0000"),pkt("done\n")]);
  const original = Buffer.from(body); let observed: Buffer | undefined;
  const transport = new CoworkGitHubReadTransport(f.readAuthority,{get:async()=>{body.fill(88);return "fixture-only-token";}},async(_url,init)=>{
    observed=Buffer.from(init.body as Uint8Array);
    return new Response(pkt("NAK\n"),{headers:{"content-type":"application/x-git-upload-pack-result"}});
  },{recheckMs:1000},{isolatedFixture:true});
  await transport.read(f.caller,{...f.request,operation:"upload-pack",body});
  expect(observed).toEqual(original);
});
