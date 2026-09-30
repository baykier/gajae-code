### Features

- Add live status cards for the Feishu app bot (`feishu-app`): one ephemeral card per running turn mirrors the active tool (with ✓/✗ outcome and duration), the latest streamed text, and model/token context, redrawn at most once every 3 seconds and deleted when the final answer lands or the session closes. Controlled by `notifications.feishu-app.streaming.enabled` (default on); with the lane active, mirrored live frames are no longer double-posted as plain text.
