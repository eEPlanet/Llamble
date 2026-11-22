package com.llamble.app;

import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Where call sound comes out, like a phone's dialer: the earpiece (held to your ear, with the
 * screen turned off by the proximity sensor), the speaker, a wired headset, or Bluetooth.
 * Phone-style calls (DMs, parties) start on the earpiece and voice rooms on the speaker; a
 * headset or Bluetooth that's connected always wins. The page picks with
 * {"cmd":"audio-route","id":...} and hears {"event":"audio-routes",...} (client/src/audioroute.ts).
 */
final class AudioRoute {
    private static AudioManager am;
    private static Bridge bridge;
    private static PowerManager.WakeLock proximity;
    private static boolean active;
    private static String chosen; // what the person picked during this call
    private static AudioDeviceCallback watcher;
    private static Object commListener; // AudioManager.OnCommunicationDeviceChangedListener (Android 12+)
    private static final java.util.Set<String> known = new java.util.HashSet<>();

    private static String key(AudioDeviceInfo d) {
        return kind(d.getType()) + ":" + d.getProductName();
    }
    private static android.content.BroadcastReceiver screen;
    private static Context appContext;
    private static long pickedAt; // when we last chose a route ourselves
    private static boolean retried; // put it back at most once per choice (re-setting it is what made switching feel laggy)
    private static String lastSeen;
    private static final Handler ui = new Handler(Looper.getMainLooper());
    /** Every second in a call: keep the screen-off-at-your-ear in step with where sound really
     *  goes, and if the web view moves the sound right after we chose (it sets up its own call
     *  sound as calls connect), put it back. */
    private static final Runnable check = new Runnable() {
        @Override
        public void run() {
            if (!active || am == null) return;
            String now = actualKind();
            String want = chosen == null ? null : chosen.split(":")[0];
            if (want != null && now != null && !want.equals(now) && !want.equals("bluetooth") && !retried && System.currentTimeMillis() - pickedAt > 2500 && System.currentTimeMillis() - pickedAt < 8000) {
                retried = true;
                apply(chosen, false);
            } else {
                ear("earpiece".equals(now));
                if (now != null && !now.equals(lastSeen)) report();
            }
            lastSeen = now;
            ui.postDelayed(this, 1000);
        }
    };

    /** A call started (phone = a DM or party call, else a voice room). */
    static void begin(Context c, Bridge b, boolean phone) {
        am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        bridge = b;
        if (active) return;
        active = true;
        chosen = null;
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (proximity == null) {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            if (pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK))
                proximity = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "llamble:ear");
        }
        List<String[]> r = routes();
        String pick = find(r, "bluetooth");
        if (pick == null) pick = find(r, "headset");
        if (pick == null) pick = find(r, phone ? "earpiece" : "speaker");
        if (pick != null) apply(pick);
        ui.removeCallbacks(check);
        ui.postDelayed(check, 1000);
        // Bluetooth phone audio (and some headsets) shows up as a new device each time its audio
        // link opens, e.g. after switching from the speaker back to the car. Only a device that
        // really just connected switches the call to it, and a device has to stay gone for a
        // couple of seconds before the call falls back; reacting to every blip made the sound
        // jump around and stutter.
        known.clear();
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) known.add(key(d));
        watcher = new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                for (AudioDeviceInfo d : added) {
                    String k = kind(d.getType());
                    if (k == null || !(k.equals("bluetooth") || k.equals("headset"))) continue;
                    if (!known.add(key(d))) continue; // seen this call already: not a new connection
                    if (System.currentTimeMillis() - pickedAt < 3000) continue; // someone just picked
                    ui.postDelayed(() -> {
                        String id = find(routes(), k);
                        if (active && id != null) apply(id);
                    }, 800);
                    return;
                }
                report();
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                ui.postDelayed(() -> {
                    if (!active) return;
                    List<String[]> now = routes();
                    for (AudioDeviceInfo d : removed) {
                        String k = kind(d.getType());
                        if (k != null && find(now, k) == null) known.remove(key(d));
                    }
                    // the device in use is really gone: Bluetooth, then a headset, then the earpiece
                    if (chosen != null && find(now, chosen.split(":")[0]) == null) {
                        String id = find(now, "bluetooth");
                        if (id == null) id = find(now, "headset");
                        if (id == null) id = find(now, "earpiece");
                        if (id == null) id = find(now, "speaker");
                        if (id != null) apply(id);
                    }
                    report();
                }, 2500);
            }
        };
        am.registerAudioDeviceCallback(watcher, new Handler(Looper.getMainLooper()));
        if (Build.VERSION.SDK_INT >= 31 && commListener == null) {
            AudioManager.OnCommunicationDeviceChangedListener l = d -> {
                if (!active) return;
                ear(d != null && d.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
                report();
            };
            am.addOnCommunicationDeviceChangedListener(c.getMainExecutor(), l);
            commListener = l;
        }
        // the screen timing out could leave call sound stuck until the route was changed by
        // hand: when the screen goes off or on, set the same route again and wake the page's sound
        screen = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, android.content.Intent i) {
                ui.postDelayed(() -> {
                    if (!active) return;
                    if (chosen != null) apply(chosen, false);
                    if (bridge != null) bridge.send("audio-wake");
                }, 700);
            }
        };
        android.content.IntentFilter f = new android.content.IntentFilter(android.content.Intent.ACTION_SCREEN_OFF);
        f.addAction(android.content.Intent.ACTION_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 33) c.getApplicationContext().registerReceiver(screen, f, Context.RECEIVER_NOT_EXPORTED);
        else c.getApplicationContext().registerReceiver(screen, f);
        appContext = c.getApplicationContext();
    }

    /** The call ended: give the sound back to Android. */
    static void end() {
        if (!active || am == null) return;
        active = false;
        ui.removeCallbacks(check);
        if (screen != null && appContext != null) {
            try {
                appContext.unregisterReceiver(screen);
            } catch (Exception ignored) {
            }
        }
        screen = null;
        if (watcher != null) am.unregisterAudioDeviceCallback(watcher);
        watcher = null;
        if (Build.VERSION.SDK_INT >= 31 && commListener != null) am.removeOnCommunicationDeviceChangedListener((AudioManager.OnCommunicationDeviceChangedListener) commListener);
        commListener = null;
        if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
        else {
            am.setSpeakerphoneOn(false);
            if (am.isBluetoothScoOn()) {
                am.stopBluetoothSco();
                am.setBluetoothScoOn(false);
            }
        }
        am.setMode(AudioManager.MODE_NORMAL);
        ear(false);
    }

    /** id = "<kind>:<device id>" */
    static void apply(String id) {
        apply(id, true);
    }

    private static void apply(String id, boolean fresh) {
        if (am == null || id == null || id.isEmpty()) return;
        chosen = id;
        if (fresh) {
            pickedAt = System.currentTimeMillis();
            retried = false;
        }
        String kind = id.split(":")[0];
        if (Build.VERSION.SDK_INT >= 31) {
            int dev = Integer.parseInt(id.split(":")[1]);
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                if (d.getId() == dev) {
                    am.setCommunicationDevice(d);
                    break;
                }
            }
        } else {
            boolean bt = kind.equals("bluetooth");
            if (!bt && am.isBluetoothScoOn()) {
                am.stopBluetoothSco();
                am.setBluetoothScoOn(false);
            }
            am.setSpeakerphoneOn(kind.equals("speaker"));
            if (bt) {
                am.startBluetoothSco();
                am.setBluetoothScoOn(true);
            }
        }
        ear(kind.equals("earpiece") && "earpiece".equals(actualKind()));
        report();
    }

    /** where call sound actually goes right now */
    private static String actualKind() {
        if (Build.VERSION.SDK_INT >= 31) {
            AudioDeviceInfo d = am.getCommunicationDevice();
            return d == null ? null : kind(d.getType());
        }
        if (am.isBluetoothScoOn()) return "bluetooth";
        if (am.isSpeakerphoneOn()) return "speaker";
        if (am.isWiredHeadsetOn()) return "headset";
        return "earpiece";
    }

    /** Tell the page what's available and what's in use. */
    static void report() {
        if (bridge == null || am == null) return;
        try {
            JSONArray arr = new JSONArray();
            for (String[] r : routes()) arr.put(new JSONObject().put("id", r[0]).put("kind", r[1]).put("name", r[2]));
            bridge.send("audio-routes", "routes", arr, "current", current());
        } catch (Exception ignored) {
        }
    }

    private static String current() {
        if (chosen != null && System.currentTimeMillis() - pickedAt < 2500) return chosen;
        if (Build.VERSION.SDK_INT >= 31) {
            AudioDeviceInfo d = am.getCommunicationDevice();
            String k = d == null ? null : kind(d.getType());
            return k == null ? chosen : k + ":" + d.getId();
        }
        return chosen;
    }

    /** {id, kind, name} for each place sound can go right now */
    private static List<String[]> routes() {
        List<String[]> out = new ArrayList<>();
        if (am == null) return out;
        if (Build.VERSION.SDK_INT >= 31) {
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                String k = kind(d.getType());
                if (k == null || find(out, k) != null && !k.equals("bluetooth")) continue;
                out.add(new String[]{k + ":" + d.getId(), k, k.equals("bluetooth") ? String.valueOf(d.getProductName()) : ""});
            }
        } else {
            boolean hasEar = false;
            for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                String k = kind(d.getType());
                if (k == null || find(out, k) != null) continue;
                if (k.equals("earpiece")) hasEar = true;
                out.add(new String[]{k + ":" + d.getId(), k, k.equals("bluetooth") ? String.valueOf(d.getProductName()) : ""});
            }
            if (!hasEar && find(out, "headset") == null) out.add(0, new String[]{"earpiece:0", "earpiece", ""});
        }
        return out;
    }

    private static String find(List<String[]> list, String kind) {
        for (String[] r : list) if (r[1].equals(kind)) return r[0];
        return null;
    }

    private static String kind(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return "earpiece";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return "speaker";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
                return "headset";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                return "bluetooth";
            default:
                if (Build.VERSION.SDK_INT >= 31 && (type == AudioDeviceInfo.TYPE_BLE_HEADSET || type == AudioDeviceInfo.TYPE_BLE_SPEAKER)) return "bluetooth";
                return null;
        }
    }

    /** Held to the ear: the proximity sensor turns the screen off so your cheek can't tap things. */
    /** the call screen is showing (the page says so): only then may the ear sensor blank the
     *  screen; while you're reading the chat during a call, it never does */
    static boolean callScreen;

    static void setCallScreen(boolean on) {
        callScreen = on;
        if (active && am != null) ear("earpiece".equals(actualKind()));
    }

    private static void ear(boolean on) {
        on = on && callScreen;
        if (proximity == null) return;
        try {
            if (on && !proximity.isHeld()) proximity.acquire(6 * 3600 * 1000L);
            else if (!on && proximity.isHeld()) proximity.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY);
        } catch (Exception ignored) {
        }
    }
}
