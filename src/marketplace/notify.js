// Phone push via ntfy.sh — a plain HTTP POST to a topic, no account or SDK.
// The watcher sends AGGREGATE messages only ("7 new listings…"), never one
// push per listing. An empty NTFY_TOPIC disables pushes entirely; failures
// return false so callers can leave listings unnotified and retry next run.

import { config } from '../config.js';

export async function sendNtfy({ title, message, clickUrl, priority = 'default' }) {
  if (!config.ntfyTopic) return false;
  const url = `${config.ntfyServer.replace(/\/+$/, '')}/${encodeURIComponent(config.ntfyTopic)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: message,
      headers: {
        Title: title,
        Priority: priority,
        ...(clickUrl ? { Click: clickUrl } : {}),
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}
