package com.llamble.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** "Decline" on the incoming-call notification: stop ringing and tell the server (the caller sees it). */
public class CallAction extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        String ch = intent.getStringExtra("channel_id");
        Notify.cancel(c, intent.getStringExtra("tag"));
        SharedPreferences p = ListenerService.prefs(c);
        String server = p.getString("server", null), token = p.getString("token", null);
        if (ch == null || server == null || token == null) return;
        PendingResult done = goAsync();
        new Thread(() -> {
            try {
                HttpURLConnection h = (HttpURLConnection) new URL(server.replaceAll("/+$", "") + "/api/channels/" + ch + "/ring/end").openConnection();
                h.setRequestMethod("POST");
                h.setDoOutput(true);
                h.setConnectTimeout(10_000);
                h.setReadTimeout(10_000);
                h.setRequestProperty("Authorization", "Bearer " + token);
                h.setRequestProperty("Content-Type", "application/json");
                try (OutputStream o = h.getOutputStream()) {
                    o.write("{\"reason\":\"declined\"}".getBytes("UTF-8"));
                }
                h.getResponseCode();
                h.disconnect();
            } catch (Exception ignored) {
            } finally {
                done.finish();
            }
        }).start();
    }
}
