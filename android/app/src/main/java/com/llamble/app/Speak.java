package com.llamble.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

/**
 * Says something out loud with the phone's own voice, on the speaker (like a voicemail
 * greeting you can hear across the room). The page asks with {"cmd":"say","text":...,"id":...}
 * and hears {"event":"said","id":...} when it's finished (or couldn't be said).
 */
final class Speak {
    private static TextToSpeech tts;
    private static boolean ready;
    private static String pendingText, pendingId;
    private static Bridge bridge;

    static void say(Context c, Bridge b, String text, String id) {
        bridge = b;
        if (tts == null) {
            pendingText = text;
            pendingId = id;
            tts = new TextToSpeech(c.getApplicationContext(), status -> {
                ready = status == TextToSpeech.SUCCESS;
                if (!ready) {
                    done(pendingId);
                    tts = null;
                    return;
                }
                tts.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String u) { }
                    @Override public void onDone(String u) { done(u); }
                    @Override public void onError(String u) { done(u); }
                    @Override public void onStop(String u, boolean interrupted) { done(u); }
                });
                if (pendingText != null) speak(pendingText, pendingId);
                pendingText = null;
            });
            return;
        }
        if (!ready) {
            done(id);
            return;
        }
        speak(text, id);
    }

    private static void speak(String text, String id) {
        Bundle p = new Bundle();
        p.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f);
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, p, id) != TextToSpeech.SUCCESS) done(id);
    }

    static void stop() {
        if (tts != null) tts.stop();
    }

    private static void done(String id) {
        if (bridge != null && id != null) bridge.send("said", "id", id);
    }
}
