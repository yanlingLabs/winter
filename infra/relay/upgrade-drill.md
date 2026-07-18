# Relay upgrade drill

Exact steps to roll a new pinned `iroh-relay` version onto a running relay VM, with a rollback
path, plus the timestamped transcript of the drill actually executed once against `norma-relay-2`
(SP2b Task 6 Step 6 -- re-installing the SAME pinned version counts as the drill; a version bump
follows the identical procedure).

This never touches both relays at once -- roll one, health-check it, THEN roll the other. A
phone/Mac mid-pairing over the untouched relay is unaffected the whole time.

## Steps

1. **Pick the new version** and compute its sha256 (same artifact `provision.ts` itself pins):

   ```sh
   NEW_VERSION=1.0.3   # example
   curl -fL -o /tmp/iroh-relay-new.tar.gz \
     "https://github.com/n0-computer/iroh/releases/download/v${NEW_VERSION}/iroh-relay-v${NEW_VERSION}-x86_64-unknown-linux-musl.tar.gz"
   shasum -a 256 /tmp/iroh-relay-new.tar.gz
   ```

   Update `IROH_RELAY_VERSION`/`IROH_RELAY_SHA256` at the top of `provision.ts` (so a FUTURE VM
   launched from scratch also gets the new version) -- this drill only covers rolling it onto an
   ALREADY-RUNNING box.

2. **Copy the new binary to staging** on the target relay (never overwrite the live binary
   directly -- a partial `scp` mid-write must never be what `systemctl restart` picks up):

   ```sh
   scp /tmp/iroh-relay-new.tar.gz ubuntu@relay-2.yanlinglabs.com:/tmp/
   ssh ubuntu@relay-2.yanlinglabs.com
   tar xzf /tmp/iroh-relay-new.tar.gz -C /tmp
   sha256sum /tmp/iroh-relay   # compare against the value from step 1
   sudo mv /usr/local/bin/iroh-relay /usr/local/bin/iroh-relay.prev   # rollback copy
   sudo install -o root -g root -m 0755 /tmp/iroh-relay /usr/local/bin/iroh-relay.next
   ```

3. **Stop, swap, start:**

   ```sh
   sudo systemctl stop iroh-relay
   sudo mv /usr/local/bin/iroh-relay.next /usr/local/bin/iroh-relay
   sudo systemctl start iroh-relay
   systemctl status iroh-relay --no-pager
   ```

4. **Health-check** from your Mac:

   ```sh
   bun infra/relay/health-check.ts relay-2.yanlinglabs.com
   ```

5. **Rollback** (only if step 4 fails): the pre-swap binary is still at
   `/usr/local/bin/iroh-relay.prev`:

   ```sh
   sudo systemctl stop iroh-relay
   sudo mv /usr/local/bin/iroh-relay.prev /usr/local/bin/iroh-relay
   sudo systemctl start iroh-relay
   ```

   Re-run `health-check.ts` to confirm the rollback itself is healthy.

6. **Cleanup** (only after a healthy new version has run for a while and the rollback copy is no
   longer wanted): `sudo rm -f /usr/local/bin/iroh-relay.prev`.

## Drill transcript

**Status: PENDING.** This drill requires `norma-relay-2` to actually exist, which requires the
Oracle tenancy's compute APIs to have finished provisioning (`GET .../availabilityDomains` was
still returning `404 NotAuthorizedOrNotFound` at the time this file was written -- see
`README.md`'s "Oracle tenancy provisioning state" section and `task-6-report.md`). Once the
tenancy is live and `provision.ts` has actually launched both instances, run the drill above
against `norma-relay-2` (reinstalling the SAME pinned version satisfies "EXECUTE it once" -- no
version bump is required for the drill itself) and paste the real, timestamped transcript here:

```
$ date -u
<pending>
$ ssh ubuntu@relay-2.yanlinglabs.com sha256sum /usr/local/bin/iroh-relay
<pending>
$ sudo systemctl stop iroh-relay && sudo systemctl start iroh-relay
<pending>
$ bun infra/relay/health-check.ts relay-2.yanlinglabs.com
<pending>
```
