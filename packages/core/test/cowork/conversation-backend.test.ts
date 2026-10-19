// Session door D3: the repository's conversation location and the write-once backend identity (migration 18's columns).
import { afterEach, expect, test } from "bun:test";
import { doorFixture, type DoorFixture } from "./session-door-fixture";

const fixtures: DoorFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const BACKEND = "0b6d7c4e-5a1f-4c2e-9d3b-7e8f9a0b1c2d";

test("a source binding reads back; its backend identity is null until recorded, then written once", () => {
  const f = doorFixture({ sessions: ["conversation", "other"] }); fixtures.push(f);
  expect(f.records.conversationLocation("conversation")).toBe("source");
  expect(f.records.conversationBackend("conversation")).toBeNull();
  f.records.assignConversationBackend("conversation", BACKEND);
  expect(f.records.conversationBackend("conversation")).toBe(BACKEND);
  // The same value again is a no-op; any other value is refused and changes nothing.
  f.records.assignConversationBackend("conversation", BACKEND);
  expect(() => f.records.assignConversationBackend("conversation", "1b6d7c4e-5a1f-4c2e-9d3b-7e8f9a0b1c2d")).toThrow("authority_denied");
  expect(f.records.conversationBackend("conversation")).toBe(BACKEND);
  // Unique across conversations (the column's own constraint).
  expect(() => f.records.assignConversationBackend("other", BACKEND)).toThrow();
  expect(f.records.conversationBackend("other")).toBeNull();
  // Unknown, malformed, or an inactive conversation.
  expect(() => f.records.conversationBackend("missing")).toThrow("not_found");
  expect(() => f.records.assignConversationBackend("missing", BACKEND)).toThrow("not_found");
  expect(() => f.records.assignConversationBackend("other", "bad id with spaces")).toThrow("invalid_request");
  f.db.db.run("UPDATE cowork_conversations SET state='archived' WHERE session_id='other'");
  expect(() => f.records.assignConversationBackend("other", "2b6d7c4e-5a1f-4c2e-9d3b-7e8f9a0b1c2d")).toThrow("authority_denied");
});

test("an outputs row is located, but never read as a binding with a null source (the outputs slice is D3b)", () => {
  const f = doorFixture(); fixtures.push(f);
  f.db.db.run("UPDATE cowork_conversations SET location_kind='outputs', source_id=NULL, relative_cwd='.' WHERE session_id='conversation'");
  expect(f.records.conversationLocation("conversation")).toBe("outputs");
  expect(() => f.records.binding("conversation")).toThrow("unsupported_topology");
  expect(() => f.records.conversationLocation("missing")).toThrow("not_found");
});
