const { Resend } = require("resend");
const { Clerk } = require("@clerk/backend");
const { Pool } = require("pg");

export const QUERIES = {
  getUserInfo: `
    SELECT email FROM user_homes WHERE home_id = $1 LIMIT 1
  `,
  getUnsentAlerts: `
    SELECT id, home_id, user_id, message FROM alert_log WHERE sent_status = 0 ORDER BY created_at ASC LIMIT 10
  `,
  updateAlertStatus: `
    UPDATE alert_log SET sent_status = 1 WHERE id = $1
  `,
};

let pgPool;

function getPgPool(connectionString) {
  if (pgPool) return pgPool;
  pgPool = new Pool({
    connectionString,
    ssl: {
      rejectUnauthorized: false,
    },
    max: 1,
  });
  return pgPool;
}

async function getUserDetailsFromClerk(userId, clerkClient) {
  if (!userId) {
    console.warn("getUserDetailsFromClerk called with no userId");
    return { firstName: null, email: null };
  }
  try {
    const user = await clerkClient.users.getUser(userId);
    const primaryEmail = user.emailAddresses.find(
      (e) => e.id === user.primaryEmailAddressId
    );
    return {
      firstName: user.firstName,
      email: primaryEmail?.emailAddress || null,
    };
  } catch (error) {
    console.error(`Error fetching user ${userId} from Clerk:`, error.message);
    if (error.status === 404) {
      console.warn(`User ${userId} not found in Clerk.`);
    }
    return { firstName: null, email: null };
  }
}

async function processAlertBatch(pool, resend, clerkClient) {
  let processedCount = 0;
  let successfulCount = 0;
  let failedCount = 0;

  try {
    const { rows: alerts } = await pool.query(QUERIES.getUnsentAlerts);

    if (!alerts || alerts.length === 0) {
      console.log("No unsent alerts to process.");
      return {
        processed: 0,
        successful: 0,
        failed: 0,
        message: "No alerts to process.",
      };
    }

    processedCount = alerts.length;

    for (const alert of alerts) {
      try {
        const { id: alertId, home_id, user_id, message: alertMessage } = alert;

        const clerkUserDetails = await getUserDetailsFromClerk(
          user_id,
          clerkClient
        );

        let homeSpecificEmail = null;
        if (home_id) {
          const { rows: homeInfoRows } = await pool.query(QUERIES.getUserInfo, [
            home_id,
          ]);
          homeSpecificEmail = homeInfoRows[0]?.email;
        }

        const recipientEmail = homeSpecificEmail || clerkUserDetails.email;

        if (!recipientEmail) {
          console.error(
            `No recipient email found for alert_id: ${alertId} (user_id: ${user_id}, home_id: ${home_id}). Skipping.`
          );
          failedCount++;
          continue;
        }

        const subject = "Smart Home Alert";
        const greeting = clerkUserDetails.firstName
          ? `Hi ${clerkUserDetails.firstName},`
          : "Hi there,";
        const textBody = `${greeting}\n\nThis is a notification regarding your smart home system:\n\n${alertMessage}\n\nAlert ID: ${alertId}`;

        await resend.emails.send({
          from: "onboarding@resend.dev",
          to: recipientEmail,
          subject: subject,
          text: textBody,
        });

        await pool.query(QUERIES.updateAlertStatus, [alertId]);
        console.log(
          `Successfully processed and sent alert_id: ${alertId} to ${recipientEmail}`
        );
        successfulCount++;
      } catch (error) {
        failedCount++;
        console.error(
          `Failed to process alert_id: ${alert.id}. Error:`,
          error.message
        );
      }
    }
  } catch (error) {
    console.error("Error fetching or processing alert batch:", error);
    return {
      processed: processedCount,
      successful: successfulCount,
      failed: failedCount + (processedCount - successfulCount - failedCount),
      error: "Batch processing failed: " + error.message,
    };
  }

  return {
    message: `Batch processing complete. Processed: ${processedCount}, Successful: ${successfulCount}, Failed: ${failedCount}`,
    processed: processedCount,
    successful: successfulCount,
    failed: failedCount,
  };
}

export default {
  async fetch(request, env, _ctx) {
    if (request.method === "GET") {
      return new Response("Notification Worker Running", { status: 200 });
    }

    if (request.method === "POST") {
      if (!env.DATABASE_URL) {
        console.error("DATABASE_URL not configured.");
        return new Response(
          JSON.stringify({
            success: false,
            error: "Server configuration error: Database URL missing.",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      if (!env.CLERK_SECRET_KEY) {
        console.error("CLERK_SECRET_KEY not configured.");
        return new Response(
          JSON.stringify({
            success: false,
            error: "Server configuration error: Clerk secret key missing.",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      if (!env.RESEND_API_KEY) {
        console.error("RESEND_API_KEY not configured.");
        return new Response(
          JSON.stringify({
            success: false,
            error: "Server configuration error: Resend API key missing.",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      let currentPool;
      try {
        currentPool = getPgPool(env.DATABASE_URL);
        const clerkClient = Clerk({ secretKey: env.CLERK_SECRET_KEY });
        const resend = new Resend(env.RESEND_API_KEY);

        const result = await processAlertBatch(
          currentPool,
          resend,
          clerkClient
        );

        return new Response(JSON.stringify({ success: true, ...result }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("Error in POST request handler:", error);
        return new Response(
          JSON.stringify({
            success: false,
            error: "Failed to process alert batch: " + error.message,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};
