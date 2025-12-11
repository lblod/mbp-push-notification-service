export async function sendNotification(deviceId, filter) {
  console.log(`Pretending to notify device ${deviceId}...`);
}

export function buildNotification({
  appointmentId,
  client,
  title,
  body,
  triggerDate,
  url
}) {
  return {
    content: {
      subtitle: "Herinnering",
      body,
      title,
      priority: "high",
      data: {
        appointmentId,
        type: "embed",
        client
      }
    },
    trigger: {
      date: triggerDate
    },
    action: {
      type: "embed",
      url
    },
    identifier: String(Math.floor(Math.random() * 1_000_000_000_000))
  };
}
