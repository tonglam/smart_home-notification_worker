import { connect } from "mqtt";
import { Resend } from "resend";

// MQTT client configuration
const MQTT_CONFIG = {
  host: "abe3cde2e1524333b6306bbe4a8d8b28.s1.eu.hivemq.cloud",
  port: 8883,
  protocol: "mqtts",
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
};

// Initialize Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

// Database queries
const QUERIES = {
  insertAlert: `
    INSERT INTO alert_log (home_id, user_id, device_id, message, sent_status)
    VALUES (?, ?, ?, ?, 0)
    RETURNING id
  `,
  getUserEmail: `
    SELECT email FROM user_homes WHERE home_id = ? LIMIT 1
  `,
  updateAlertStatus: `
    UPDATE alert_log SET sent_status = 1 WHERE id = ?
  `,
};

/**
 * Handle incoming MQTT messages
 * @param {string} topic - MQTT topic
 * @param {Buffer} message - Message payload
 * @param {D1Database} db - D1 database instance
 */
async function handleMqttMessage(topic, message, db) {
  try {
    // Parse message payload
    const payload = JSON.parse(message.toString());
    const { home_id, device_id, message: alertMessage } = payload;

    if (!home_id || !device_id || !alertMessage) {
      throw new Error("Invalid message payload: missing required fields");
    }

    // Insert alert into database
    const [alertResult] = await db
      .prepare(QUERIES.insertAlert)
      .bind(home_id, "system", device_id, alertMessage)
      .all();

    if (!alertResult?.id) {
      throw new Error("Failed to insert alert");
    }

    // Get user email
    const [userResult] = await db
      .prepare(QUERIES.getUserEmail)
      .bind(home_id)
      .all();

    if (!userResult?.email) {
      throw new Error(`No user found for home_id: ${home_id}`);
    }

    // Send email notification
    await resend.emails.send({
      from: "Smart Home Alert <alerts@yourdomain.com>",
      to: userResult.email,
      subject: "Smart Home Alert",
      text: alertMessage,
    });

    // Update alert status
    await db.prepare(QUERIES.updateAlertStatus).bind(alertResult.id).run();

    console.log(`Alert processed successfully: ${alertResult.id}`);
  } catch (error) {
    console.error("Error processing MQTT message:", error);
    // You might want to store failed attempts in a separate table or retry queue
  }
}

export default {
  async fetch(request, env, ctx) {
    return new Response("Notification Worker Running", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    try {
      const client = connect(MQTT_CONFIG);

      client.on("connect", () => {
        console.log("Connected to MQTT broker");
        client.subscribe("/notification");
      });

      client.on("message", async (topic, message) => {
        await handleMqttMessage(topic, message, env.DB);
      });

      client.on("error", (error) => {
        console.error("MQTT client error:", error);
        client.end();
      });

      // Keep the worker running for the duration of the cron job
      await new Promise((resolve) => setTimeout(resolve, 58000)); // Run for 58 seconds
      client.end();
    } catch (error) {
      console.error("Scheduled job error:", error);
    }
  },
};
