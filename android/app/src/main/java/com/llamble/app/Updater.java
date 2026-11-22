package com.llamble.app;

import android.app.AlertDialog;
import android.content.Context;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Updates, like the Windows app: looks at Llamble's latest GitHub release and, if it has a
 * newer Llamble.apk, offers it (downloaded in the browser; Android asks you to confirm the install).
 */
final class Updater {
    static final String LATEST = "https://api.github.com/repos/eEPlanet/Llamble/releases/latest";
    static final String APK = "Llamble.apk";
    private static long lastCheck;
    private static String declined;
    private static long declinedAt;
    private static boolean busy;

    static void check(MainActivity a, boolean manual) {
        if (!BuildConfig.SELF_UPDATE) return; // the Play version is updated by Google Play
        long now = System.currentTimeMillis();
        // every time the app comes to the front, at most every 20 minutes (the process can stay
        // alive for days because of calls and notifications, so "on start" wasn't enough)
        if (busy || (!manual && now - lastCheck < 20 * 60_000L)) return;
        lastCheck = now;
        busy = true;
        new Thread(() -> {
            try {
                JSONObject rel = new JSONObject(read(LATEST));
                String latest = rel.optString("tag_name").replaceFirst("^v", "");
                String url = null;
                JSONArray assets = rel.optJSONArray("assets");
                for (int i = 0; assets != null && i < assets.length(); i++)
                    if (APK.equals(assets.getJSONObject(i).optString("name")))
                        url = assets.getJSONObject(i).optString("browser_download_url");
                String mine = a.version();
                if (url == null && compare(latest, mine) > 0) {
                    // a new version is being published but its APK isn't up yet: look again soon
                    lastCheck = System.currentTimeMillis() - 18 * 60_000L;
                }
                if (url == null || compare(latest, mine) <= 0) {
                    if (manual) a.runOnUiThread(() -> Toast.makeText(a, "Llamble is up to date (" + mine + ")", Toast.LENGTH_SHORT).show());
                    return;
                }
                a.bridge.send("update-available", "version", latest);
                // "Later" waits 12 hours before asking again; never in the middle of a call
                if (!manual && latest.equals(declined) && System.currentTimeMillis() - declinedAt < 12 * 3600_000L) return;
                if (!manual && VoiceService.running) {
                    lastCheck = System.currentTimeMillis() - 15 * 60_000L;
                    return;
                }
                final String apk = url;
                a.runOnUiThread(() -> {
                    if (a.isFinishing()) return;
                    new AlertDialog.Builder(a)
                            .setTitle("Update Llamble?")
                            .setMessage("Version " + latest + " is ready (you have " + mine + ").")
                            .setPositiveButton("Update", (d, w) -> install(a, apk))
                            .setNegativeButton("Later", (d, w) -> {
                                declined = latest;
                                declinedAt = System.currentTimeMillis();
                            })
                            .show();
                });
            } catch (Exception e) {
                if (manual) a.runOnUiThread(() -> Toast.makeText(a, "Couldn't check for updates", Toast.LENGTH_SHORT).show());
            } finally {
                busy = false;
            }
        }).start();
    }

    /** 0.1.89 vs 0.1.90 */
    static int compare(String x, String y) {
        String[] a = x.split("\\."), b = y.split("\\.");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int p = i < a.length ? num(a[i]) : 0, q = i < b.length ? num(b[i]) : 0;
            if (p != q) return Integer.compare(p, q);
        }
        return 0;
    }

    private static int num(String s) {
        try {
            return Integer.parseInt(s.replaceAll("\\D", ""));
        } catch (Exception e) {
            return 0;
        }
    }

    private static String read(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setConnectTimeout(15000);
        c.setReadTimeout(15000);
        try (InputStream in = c.getInputStream()) {
            return new String(in.readAllBytes(), "UTF-8");
        }
    }

    /**
     * The new APK downloads in the browser and Android asks to install it. (The app doesn't
     * install anything itself: apps that can install other apps get flagged by Play Protect.)
     */
    /** Download the new version and hand it to Android's installer right here (no browser, so
     *  no "this file may be harmful" download warning). The first time, Android asks to allow
     *  Llamble to install apps; after that it just asks to confirm the update. */
    private static void install(MainActivity a, String url) {
        if (!a.getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(a, "Allow Llamble to install its updates, then press back and tap Update again", Toast.LENGTH_LONG).show();
            a.startActivity(new android.content.Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, android.net.Uri.parse("package:" + a.getPackageName())));
            return;
        }
        Toast.makeText(a, "Downloading the update…", Toast.LENGTH_SHORT).show();
        android.content.Context app = a.getApplicationContext();
        new Thread(() -> {
            android.content.pm.PackageInstaller pi = app.getPackageManager().getPackageInstaller();
            int sid = -1;
            try {
                android.content.pm.PackageInstaller.SessionParams sp = new android.content.pm.PackageInstaller.SessionParams(android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                sp.setAppPackageName(app.getPackageName());
                if (android.os.Build.VERSION.SDK_INT >= 31) sp.setRequireUserAction(android.content.pm.PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                sid = pi.createSession(sp);
                android.content.pm.PackageInstaller.Session session = pi.openSession(sid);
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                c.setInstanceFollowRedirects(true);
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                try (java.io.InputStream in = c.getInputStream(); java.io.OutputStream out = session.openWrite("Llamble.apk", 0, -1)) {
                    byte[] buf = new byte[64 * 1024];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                    session.fsync(out);
                }
                android.content.Intent done = new android.content.Intent(app, UpdateResult.class);
                int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT | (android.os.Build.VERSION.SDK_INT >= 31 ? android.app.PendingIntent.FLAG_MUTABLE : 0);
                session.commit(android.app.PendingIntent.getBroadcast(app, sid, done, flags).getIntentSender());
                session.close();
            } catch (Exception e) {
                if (sid != -1) try { pi.abandonSession(sid); } catch (Exception ignored) { }
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
                        Toast.makeText(app, "Couldn't update: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }
}
