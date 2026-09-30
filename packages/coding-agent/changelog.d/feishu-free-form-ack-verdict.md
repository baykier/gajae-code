### Fixes

- feishu-app: free-form acks now read the steer verdict from the durable ledger projection's `status` field. The live host never emits the `accepted` boolean the daemon checked, so every routed group message was acked with the false-negative 「会话未接受该消息（队列可能已满）」 hint even though the steer had been admitted into the session.
