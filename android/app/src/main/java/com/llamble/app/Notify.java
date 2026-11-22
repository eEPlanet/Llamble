package com.llamble.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

/** Android notifications: messages and mentions (what the page would show in a browser), and the call. */
final class Notify {
    static final String MESSAGES = "messages", CALL = "call", UPDATES = "updates", LISTENING = "listening", RINGING = "ringing", URGENT = "urgent";

    static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel m = new NotificationChannel(MESSAGES, "Messages and mentions", NotificationManager.IMPORTANCE_HIGH);
        m.setDescription("Direct messages, @mentions and alarms");
        nm.createNotificationChannel(m);
        NotificationChannel call = new NotificationChannel(CALL, "Voice calls", NotificationManager.IMPORTANCE_LOW);
        call.setDescription("Shown while you're in a voice channel, so the call keeps going with the screen off");
        nm.createNotificationChannel(call);
        nm.createNotificationChannel(new NotificationChannel(UPDATES, "App updates", NotificationManager.IMPORTANCE_DEFAULT));
        // someone calling you: rings like a phone call, even with Llamble closed
        NotificationChannel ring = new NotificationChannel(RINGING, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        ring.setDescription("Rings when someone calls you on Llamble");
        ring.setSound(android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE),
                new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        ring.enableVibration(true);
        ring.setVibrationPattern(new long[]{0, 800, 600, 800, 600});
        nm.createNotificationChannel(ring);
        // an urgent voice message from family: loud like an alarm, and allowed through Do Not
        // Disturb if the person turns that on for this category
        NotificationChannel urgent = new NotificationChannel(URGENT, "Urgent voice messages", NotificationManager.IMPORTANCE_HIGH);
        urgent.setDescription("Someone in a DM or party marked a voice message urgent");
        urgent.setSound(android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_ALARM),
                new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_ALARM)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        urgent.enableVibration(true);
        urgent.setVibrationPattern(new long[]{0, 600, 300, 600, 300, 600});
        urgent.setBypassDnd(true);
        nm.createNotificationChannel(urgent);
        // Android requires this one while Llamble listens; turning it off hides it, listening carries on
        NotificationChannel conn = new NotificationChannel(LISTENING, "Listening for messages (you can turn this off)", NotificationManager.IMPORTANCE_MIN);
        conn.setDescription("Shown while Llamble listens for messages in the background. Turn it off to hide it: listening carries on.");
        conn.setShowBadge(false);
        nm.createNotificationChannel(conn);
    }

    static PendingIntent open(Context c, String tag, boolean leaveVoice) {
        return open(c, tag, leaveVoice, null, null);
    }

    static PendingIntent open(Context c, String tag, boolean leaveVoice, String channelId, String guildId) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (tag != null) i.putExtra("notification", tag);
        if (leaveVoice) i.putExtra("leave_voice", true);
        if (channelId != null && !channelId.isEmpty()) i.putExtra("open_channel", channelId);
        if (guildId != null) i.putExtra("open_guild", guildId);
        int code = (tag == null ? 0 : tag.hashCode()) + (leaveVoice ? 1 : 0);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void message(Context c, String tag, String title, String body) {
        message(c, tag, title, body, null, null);
    }

    /** a DM or @mention; the same tag twice (app and listener both saw it) shows once */
    static void message(Context c, String tag, String title, String body, String channelId, String guildId) {
        Notification n = new Notification.Builder(c, MESSAGES)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setColor(0xff8ad13c)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(open(c, tag, false, channelId, guildId))
                .build();
        c.getSystemService(NotificationManager.class).notify(tag, 1, n);
    }

    /** Someone is calling: a ringing, full-screen call notification with Answer and Decline. */
    /** ringing calls showing now (to stop them all the moment a call is answered) */
    static final java.util.Set<String> ringing = java.util.Collections.synchronizedSet(new java.util.HashSet<>());

    /** Answered (or joined any call): every ringing call notification stops. A ring still
     *  sounding takes the phone's sound away from the call (you'd hear nobody). */
    static void stopRinging(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        synchronized (ringing) {
            for (String t : ringing) nm.cancel(t, 1);
            ringing.clear();
        }
    }

    static void call(Context c, String tag, String caller, String body, String channelId, long ringId, String from, String party, boolean guest, boolean urgent) {
        // the full-screen part only SHOWS the ringing call (Accept / Decline inside the app);
        // it must never answer by itself: Android opens it whenever the phone is woken
        Intent ring = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("ring_call", channelId).putExtra("ring_id", ringId).putExtra("ring_from", from).putExtra("ring_name", caller)
                .putExtra("ring_party", party).putExtra("ring_guest", guest).putExtra("ring_urgent", urgent).putExtra("notification", tag);
        PendingIntent ringPi = PendingIntent.getActivity(c, ("r" + tag).hashCode(), ring, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent answer = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("answer_call", channelId).putExtra("notification", tag);
        PendingIntent answerPi = PendingIntent.getActivity(c, ("a" + tag).hashCode(), answer, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent decline = new Intent(c, CallAction.class).putExtra("channel_id", channelId).putExtra("tag", tag);
        PendingIntent declinePi = PendingIntent.getBroadcast(c, ("d" + tag).hashCode(), decline, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        // an urgent call rings like an alarm, through Do Not Disturb
        Notification.Builder b = new Notification.Builder(c, urgent ? URGENT : RINGING)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(caller)
                .setContentText(body)
                .setCategory(Notification.CATEGORY_CALL)
                .setColor(urgent ? 0xffef5b5f : 0xff3ba55d)
                .setOngoing(true)
                .setAutoCancel(true)
                .setTimeoutAfter(35_000)
                .setContentIntent(ringPi)
                .setFullScreenIntent(ringPi, true)
                .addAction(new Notification.Action.Builder(null, "Decline", declinePi).build())
                .addAction(new Notification.Action.Builder(null, "Answer", answerPi).build());
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT; // keeps ringing until answered, declined or ended
        ringing.add(tag);
        c.getSystemService(NotificationManager.class).notify(tag, 1, n);
    }

    /** An urgent voice message: alarm sound until opened, full screen like a call. */
    static void urgent(Context c, String tag, String title, String body, String channelId) {
        PendingIntent open = open(c, tag, false, channelId, null);
        Notification.Builder b = new Notification.Builder(c, URGENT)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(body)
                .setCategory(Notification.CATEGORY_ALARM)
                .setColor(0xffef5b5f)
                .setAutoCancel(true)
                .setTimeoutAfter(5 * 60_000)
                .setContentIntent(open)
                .setFullScreenIntent(open, true);
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT;
        c.getSystemService(NotificationManager.class).notify(tag, 1, n);
    }

    static void cancel(Context c, String tag) {
        ringing.remove(tag);
        c.getSystemService(NotificationManager.class).cancel(tag, 1);
    }
}
