import { createClerkClient } from "@clerk/backend";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { Resend } from "resend";

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

async function processAlertBatch(supabase, resend, clerkClient) {
  let processedCount = 0;
  let successfulCount = 0;
  let failedCount = 0;

  try {
    console.log("Fetching unsent alerts from Supabase...");
    const { data: alerts, error: fetchError } = await supabase
      .from("alert_log")
      .select("id, home_id, user_id, message")
      .eq("sent_status", 0)
      .order("created_at", { ascending: true })
      .limit(10);
    if (fetchError) throw fetchError;

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
      const {
        id: alertId,
        home_id: homeId,
        user_id: userId,
        message: alertMessage,
      } = alert;
      try {
        const clerkUserDetails = await getUserDetailsFromClerk(
          userId,
          clerkClient
        );

        let homeSpecificEmail = null;
        if (homeId) {
          console.log(`Fetching home email for home_id: ${homeId}`);
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
          console.error(`No recipient email for alert_id: ${alertId}`);
          failedCount++;
          continue;
        }

        const subject = "Smart Home Alert";
        const greeting = clerkUserDetails.firstName
          ? `Hi ${clerkUserDetails.firstName},`
          : "Hi there,";
        const textBody = `${greeting}\n\nThis is a notification regarding your smart home system:\n\n${alertMessage}\n\nAlert ID: ${alertId}`;

        console.log(
          `Sending email for alert_id: ${alertId} to ${recipientEmail}`
        );
        await resend.emails.send({
          from: "Smart Home Alerts <onboarding@resend.dev>",
          to: recipientEmail,
          subject,
          text: textBody,
        });
        console.log(`Email sent successfully for alert_id: ${alertId}`);

        console.log(`Updating alert status for alert_id: ${alertId}`);
        const { error: updateError } = await supabase
          .from("alert_log")
          .update({ sent_status: 1 })
          .eq("id", alertId);
        if (updateError) throw updateError;
        console.log(`Alert status updated for alert_id: ${alertId}`);

        successfulCount++;
      } catch (alertError) {
        failedCount++;
        console.error(
          `Failed processing alert ${alertId}:`,
          alertError.message
        );
      }
    }
  } catch (batchError) {
    console.error("Error in batch processing:", batchError);
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
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("Notification Worker Running", { status: 200 });
    }
    if (request.method === "POST") {
      const supabaseUrl = env.SUPABASE_URL;
      const supabaseKey = env.SUPABASE_KEY;
      if (!supabaseUrl) {
        console.error("Supabase URL missing.");
        return new Response(
          JSON.stringify({ success: false, error: "Supabase URL missing." }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      if (!supabaseKey) {
        console.error("Supabase key missing.");
        return new Response(
          JSON.stringify({ success: false, error: "Supabase key missing." }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      if (!env.CLERK_SECRET_KEY) {
        console.error("Clerk secret key missing.");
        return new Response(
          JSON.stringify({
            success: false,
            error: "Clerk secret key missing.",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      if (!env.RESEND_API_KEY) {
        console.error("Resend API key missing.");
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

  async scheduled(_event, env, ctx) {
    const supabase = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY);
    const clerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    const resend = new Resend(env.RESEND_API_KEY);
    // Run batch processing in background
    ctx.waitUntil(processAlertBatch(supabase, resend, clerkClient));
    return new Response("Scheduled batch triggered", { status: 200 });
  },
};
