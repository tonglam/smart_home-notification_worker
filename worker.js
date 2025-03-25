const mqtt = require("mqtt");
const { Resend } = require("resend");

// MQTT client configuration
const MQTT_CONFIG = {
  host: "abe3cde2e1524333b6306bbe4a8d8b28.s1.eu.hivemq.cloud",
  port: 8883,
  protocol: "mqtts",
};

// Database queries
export const QUERIES = {
  getUserInfo: `
    SELECT user_id, email FROM user_homes WHERE home_id = ? LIMIT 1
  `,
  insertAlert: `
    INSERT INTO alert_log (home_id, user_id, device_id, message, sent_status)
    VALUES (?, ?, ?, ?, 0)
    RETURNING id
  `,
  updateAlertStatus: `
    UPDATE alert_log SET sent_status = 1 WHERE id = ?
  `,
};

/**
 * Validate message payload
 * @param {Object} payload - Message payload
 * @returns {string|null} Error message if invalid, null if valid
 */
function validatePayload(payload) {
  const { home_id, device_id, message: alertMessage } = payload;
  if (!home_id || !device_id || !alertMessage) {
    return "Invalid message payload: missing required fields";
  }
  return null;
}

/**
 * Handle incoming MQTT messages
 * @param {string} topic - MQTT topic
 * @param {Buffer} message - Message payload
 * @param {D1Database} db - D1 database instance
 * @param {string} resendApiKey - Resend API key
 * @param {boolean} throwOnValidation - Whether to throw on validation errors
 */
export async function handleMqttMessage(
  _,
  message,
  db,
  resendApiKey,
  throwOnValidation = false
) {
  try {
    // Parse message payload
    const payload = JSON.parse(message.toString());

    // Validate payload
    const validationError = validatePayload(payload);
    if (validationError) {
      if (throwOnValidation) {
        throw new Error(validationError);
      } else {
        console.error("Message validation error:", validationError);
        return null;
      }
    }

    const { home_id, device_id, message: alertMessage } = payload;

    // Prepare database statements
    const userInfoStmt = db.prepare(QUERIES.getUserInfo);
    const insertStmt = db.prepare(QUERIES.insertAlert);
    const updateStmt = db.prepare(QUERIES.updateAlertStatus);

    // Get user information first
    const [userInfo] = await userInfoStmt.bind(home_id).all();

    if (!userInfo?.user_id || !userInfo?.email) {
      throw new Error(`No user found for home_id: ${home_id}`);
    }

    // Initialize Resend client
    const resend = new Resend(resendApiKey);

    // Insert alert into database using the retrieved user_id
    const [alertResult] = await insertStmt
      .bind(home_id, userInfo.user_id, device_id, alertMessage)
      .all();

    if (!alertResult?.id) {
      throw new Error("Failed to insert alert");
    }

    // Send email notification using the retrieved email
    await resend.emails.send({
      from: "Smart Home Alert <alerts@smart-home-alert.com>",
      to: userInfo.email,
      subject: "Smart Home Alert",
      text: alertMessage,
    });

    // Update alert status
    await updateStmt.bind(alertResult.id).run();

    console.log(`Alert processed successfully: ${alertResult.id}`);
    return alertResult.id;
  } catch (error) {
    console.error("Error processing MQTT message:", error);
    if (
      throwOnValidation ||
      !error.message.includes("missing required fields")
    ) {
      throw error;
    }
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    // Handle health check
    if (request.method === "GET") {
      return new Response("Notification Worker Running", { status: 200 });
    }

    // Handle notification requests
    if (request.method === "POST") {
      try {
        // Verify content type
        const contentType = request.headers.get("content-type");
        if (!contentType?.includes("application/json")) {
          return new Response("Content-Type must be application/json", {
            status: 415,
          });
        }

        // Parse request body
        const payload = await request.json();

        try {
          // Process the notification with validation errors thrown
          const alertId = await handleMqttMessage(
            "/notification",
            Buffer.from(JSON.stringify(payload)),
            env.DB,
            env.RESEND_API_KEY,
            true // Throw validation errors for HTTP requests
          );

          return new Response(
            JSON.stringify({
              success: true,
              alert_id: alertId,
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
              },
            }
          );
        } catch (error) {
          return new Response(
            JSON.stringify({
              success: false,
              error: error.message,
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
              },
            }
          );
        }
      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Invalid JSON payload",
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }
    }

    // Handle unsupported methods
    return new Response("Method Not Allowed", { status: 405 });
  },

  async scheduled(event, env, ctx) {
    let client;
    try {
      client = mqtt.connect({
        ...MQTT_CONFIG,
        username: env.MQTT_USERNAME,
        password: env.MQTT_PASSWORD,
      });

      // Wait for connection or error
      await new Promise((resolve, reject) => {
        let resolved = false;

        const onConnect = () => {
          if (!resolved) {
            resolved = true;
            console.log("Connected to MQTT broker");
            client.subscribe("/notification");
            resolve();
          }
        };

        const onError = (error) => {
          if (!resolved) {
            resolved = true;
            reject(error);
          }
        };

        client.on("connect", onConnect);
        client.on("error", onError);

        // Set a timeout
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            reject(new Error("Connection timeout"));
          }
        }, 5000);
      });

      // Set up message handler
      client.on("message", async (topic, message) => {
        try {
          // Process the notification without throwing validation errors
          await handleMqttMessage(
            topic,
            message,
            env.DB,
            env.RESEND_API_KEY,
            false
          );
        } catch (error) {
          console.error("Error handling message:", error);
        }
      });

      // Keep the worker running for the duration of the cron job
      await new Promise((resolve) => setTimeout(resolve, 58000));
    } catch (error) {
      console.error("Scheduled job error:", error);
      throw error;
    } finally {
      if (client) {
        client.end();
      }
    }
  },
};
