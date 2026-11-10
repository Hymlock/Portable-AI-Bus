# Design record for `21a0db0`

Commit `21a0db0` bounds indefinitely blocked wakes and prevents already accepted actions from
being replayed while their source mail remains unread. The choices behind that change are:

## Why journal committed actions per message?

Retaining mail is the transaction boundary: a refused action means the task is still unfinished,
so the source message must remain available for another wake. Merely discarding the partially
executed plan would not undo actions the bus had already accepted. When the provider sees the
retained message again, it can emit the same plan and repeat a send, capability call, claim, or
release. A per-message journal records each accepted side effect immediately and lets the next
wake skip only those completed actions. The journal is deleted when the runner commits or parks
the message, so its lifetime matches the retained-mail transaction it protects.

## Why signatures plus duplicate occurrence numbers instead of indices?

An action index identifies a position in one particular model response. On a retry, the provider
may reorder unrelated actions or insert a new one, shifting indices and making the same logical
action look new. A signature derived from the action's stable, key-ordered content continues to
identify that action after such reordering. The occurrence number is scoped to identical
signatures and distinguishes intentional duplicates: two identical sends in one plan remain two
actions, while the first and second occurrence retain their respective identities on replay.

## Why give blocked work a separate bound?

Blocked work and poison input have different causes and recovery signals. A claim conflict is a
valid plan waiting on external state; malformed output or a refused action is a failed attempt to
process the message. Charging claim-conflict wakes to the poison counter would park valid work as
though its input were bad and obscure the real reason. Exempting blocked work without another
limit, however, permits retained mail to trigger paid provider wakes forever. A separate blocked
counter preserves the distinction while still guaranteeing escalation after a finite number of
backed-off cycles.

## Why replace the stub action-failure test?

The old test supplied a fake brain that directly returned `retainMessages: true`. It verified the
runner's generic poison parking, but it never executed a plan, committed an action, failed a later
action, or replayed retained mail. Repairing that stub could not prove the new cross-wake invariant
without turning it into the real integration path. The replacement uses `createAgentBrain`: an
accepted send is followed by a refused claim on two wakes. It proves that the send occurs once,
the failed claim remains retryable and occurs twice, and the message is finally parked by the
existing poison bound.
