### Features

- Feishu app bot free-form chat is now the instant-reply lane: messages dispatch as `turn.steer`, so text sent while the session is mid-run is admitted into the live loop immediately instead of queueing for the next idle boundary (idle messages still become follow-ups owned by the next turn, with durable idempotent redelivery).
