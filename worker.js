import { createClerkClient } from "@clerk/backend";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { Resend } from "resend";

/**
 * Fetch user details (first name, email) from Clerk by userId.
 * Returns nulls if user not found or error occurs.
 * @param {string} userId - Clerk user ID
 * @param {object} clerkClient - Clerk backend client
 * @returns {Promise<{firstName: string|null, email: string|null}>}
 */
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

/**
 * Process a batch of unsent alerts: fetch, notify via email, and update status.
 * Handles up to 10 alerts per batch to stay within free quota limits.
 * @param {object} supabase - Supabase client
 * @param {object} resend - Resend email client
 * @param {object} clerkClient - Clerk backend client
 * @returns {Promise<object>} Batch processing summary
 */
async function processAlertBatch(supabase, resend, clerkClient) {
  let processedCount = 0;
  let successfulCount = 0;
  let failedCount = 0;

  try {
    // Only fetch unsent alerts, oldest first, up to 10 per batch (free quota friendly)
    const { data: alerts, error: fetchError } = await supabase
      .from("alert_log")
      .select("id, home_id, user_id, message")
      .eq("sent_status", 0)
      .order("created_at", { ascending: true })
      .limit(10);
    if (fetchError) throw fetchError;

    if (!alerts || alerts.length === 0) {
      return {
        processed: 0,
        successful: 0,
        failed: 0,
        message: "No alerts to process.",
      };
    }
    processedCount = alerts.length;

    for (const alert of alerts) {
      const {
        id: alertId,
        home_id: homeId,
        user_id: userId,
        message: alertMessage,
      } = alert;
      try {
        // Prefer home-specific email if available, otherwise use Clerk user email
        const clerkUserDetails = await getUserDetailsFromClerk(
          userId,
          clerkClient
        );

        let homeSpecificEmail = null;
        if (homeId) {
          const { data: homeRows, error: homeError } = await supabase
            .from("user_homes")
            .select("email")
            .eq("home_id", homeId)
            .limit(1);
          if (homeError)
            console.error(`Error fetching home email: ${homeError.message}`);
          homeSpecificEmail = homeRows?.[0]?.email || null;
        }

        const recipientEmail = homeSpecificEmail || clerkUserDetails.email;
        if (!recipientEmail) {
          // Skip if no valid recipient
          failedCount++;
          continue;
        }

        const subject = "Smart Home Alert";
        const greeting = clerkUserDetails.firstName
          ? `Hi ${clerkUserDetails.firstName},`
          : "Hi there,";
        const textBody = `${greeting}\n\nThis is a notification regarding your smart home system:\n\n${alertMessage}\n\nAlert ID: ${alertId}\n\n--\nSmart Home Team\n`;

        // Compose HTML email (simple, readable, and branded)
        const htmlBody = `
          <div style="font-family: Arial, sans-serif; background: #f7f7f9; padding: 32px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
              <tr>
                <td style="background: #2d7ff9; color: #fff; padding: 24px 32px 16px 32px; border-radius: 8px 8px 0 0; text-align: center;">
                  <h1 style="margin: 0; font-size: 1.6em; letter-spacing: 1px;">Smart Home Alert</h1>
                </td>
              </tr>
              <tr>
                <td style="padding: 24px 32px 8px 32px;">
                  <p style="font-size: 1.1em; margin: 0 0 16px 0;">${greeting}</p>
                  <p style="font-size: 1em; color: #222; margin: 0 0 18px 0;">This is a notification regarding your smart home system:</p>
                  <div style="background: #f1f6ff; border-left: 4px solid #2d7ff9; padding: 16px; margin-bottom: 18px; border-radius: 4px; color: #1a2a3a; font-size: 1.08em;">
                    ${alertMessage}
                  </div>
                  <p style="color: #888; font-size: 0.98em; margin: 0 0 8px 0;">Alert ID: <b>${alertId}</b></p>
                </td>
              </tr>
              <tr>
                <td style="padding: 0 32px 24px 32px;">
                  <p style="font-size: 0.97em; color: #888; margin: 0;">If you have any questions, please contact our support team.<br><br>--<br>Smart Home Team</p>
                </td>
              </tr>
            </table>
          </div>
        `;

        await resend.emails.send({
          from: "Smart Home Alerts <notifications@qitonglan.com>",
          to: recipientEmail,
          subject,
          text: textBody,
          html: htmlBody,
        });

        // Mark alert as sent in DB
        const { error: updateError } = await supabase
          .from("alert_log")
          .update({ sent_status: 1 })
          .eq("id", alertId);
        if (updateError) throw updateError;

        successfulCount++;
      } catch (alertError) {
        failedCount++;
      }
    }
  } catch (batchError) {
    return {
      processed: processedCount,
      successful: successfulCount,
      failed: failedCount + (processedCount - successfulCount - failedCount),
      error: batchError.message,
    };
  }

  return {
    processed: processedCount,
    successful: successfulCount,
    failed: failedCount,
    message: `Batch complete. Processed: ${processedCount}, Successful: ${successfulCount}, Failed: ${failedCount}`,
  };
}

export default {
  /**
   * Cloudflare Worker fetch handler. Accepts GET (health) and POST (trigger batch) requests.
   * @param {Request} request
   * @param {object} env - Environment variables
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("Notification Worker Running", { status: 200 });
    }
    if (request.method === "POST") {
      const supabaseUrl = env.SUPABASE_URL;
      const supabaseKey = env.SUPABASE_KEY;
      if (!supabaseUrl) {
        return new Response(
          JSON.stringify({ success: false, error: "Supabase URL missing." }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      if (!supabaseKey) {
        return new Response(
          JSON.stringify({ success: false, error: "Supabase key missing." }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      if (!env.CLERK_SECRET_KEY) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Clerk secret key missing.",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      if (!env.RESEND_API_KEY) {
        return new Response(
          JSON.stringify({ success: false, error: "Resend API key missing." }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      const supabase = createSupabaseClient(supabaseUrl, supabaseKey);
      const clerkClient = createClerkClient({
        secretKey: env.CLERK_SECRET_KEY,
      });
      const resend = new Resend(env.RESEND_API_KEY);

      const result = await processAlertBatch(supabase, resend, clerkClient);
      return new Response(JSON.stringify({ success: true, ...result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Method Not Allowed", { status: 405 });
  },

  /**
   * Cloudflare Worker scheduled event handler. Triggers batch processing in background.
   * @param {ScheduledEvent} _event
   * @param {object} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async scheduled(_event, env, ctx) {
    const supabase = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY);
    const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    const resend = new Resend(env.RESEND_API_KEY);
    // Run batch processing in background for reliability
    ctx.waitUntil(processAlertBatch(supabase, resend, clerkClient));
    return new Response("Scheduled batch triggered", { status: 200 });
  },
};
