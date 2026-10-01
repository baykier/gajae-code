### Fixes

- feishu-app: one ack per message under Feishu event redelivery. Feishu's long connection re-pushes the same message event (~20s apart), and every push ran the full free-form path: a second steer plus a second「已提交到会话。」ack for one user message. Inbound message events are now deduped on their message id with a 10-minute TTL and a bounded LRU, so a genuinely repeated user message stays deliverable.
