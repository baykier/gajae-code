### Fixes

- feishu-app: duplicate finalized answers are gone. Duplicate deliveries of one turn's answer could disagree on the SDK message ref, so the publication dedup key went empty and the same answer posted twice to the chat. The dedup now keys on the turn correlation when the message ref is missing, collapsing both twins onto one publication identity.
