package com.rescue.light;

import android.app.Activity;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.TextView;
import java.util.List;

/**
 * Full-screen emergency signal light. Tap cycles modes, long-press toggles an
 * alarm tone synced to the light; both persist. Brightness is forced and the
 * whole panel, display cutout included, emits.
 */
public class Main extends Activity {

    record Step(boolean lit, int duration, boolean beep) {}

    record Mode(String name, int color, float brightness, int tone, List<Step> steps) {}

    static final int WHITE = 0xFFFFFFFF;
    static final int BLACK = 0xFF000000;
    static final int GREEN = 0xFF00FF00;
    static final int SAMPLE_RATE = 44100;

    static final List<Mode> MODES = List.of(
        new Mode("MAX WHITE", WHITE, 1f, 3000, List.of(pulse(300), glow(900))),
        new Mode("SOS", WHITE, 1f, 3000, sos()),
        new Mode("STROBE", WHITE, 1f, 3000, List.of(pulse(200), dark(800))),
        new Mode("BATTERY", GREEN, 0.5f, 2200, List.of(pulse(300), dark(3000))));

    static final AudioAttributes ALARM_OUTPUT = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();

    static final AudioFormat MONO_16_BIT = new AudioFormat.Builder()
        .setSampleRate(SAMPLE_RATE)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build();

    final Runnable animator = this::advance;

    SharedPreferences preferences;
    AudioTrack tone;
    View screen;
    TextView label;
    boolean audioOn;
    int mode;
    int step;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("rescuelight", MODE_PRIVATE);
        audioOn = preferences.getBoolean("audio", false);
        mode = preferences.getInt("mode", 0);

        setContentView(R.layout.main);
        screen = findViewById(R.id.screen);
        label = findViewById(R.id.label);
        screen.setOnClickListener(view -> applyMode((mode + 1) % MODES.size()));
        screen.setOnLongClickListener(view -> toggleAudio());
        goImmersive();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (audioOn) maxAlarmVolume();
        applyMode(mode);
    }

    @Override
    protected void onPause() {
        super.onPause();
        screen.removeCallbacks(animator);
        stopTone();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();
    }

    /** setDecorFitsSystemWindows is deprecated in API 35 but required below it. */
    @SuppressWarnings("deprecation")
    void goImmersive() {
        getWindow().setDecorFitsSystemWindows(false);
        WindowInsetsController bars = getWindow().getInsetsController();
        bars.hide(WindowInsets.Type.systemBars());
        bars.setSystemBarsBehavior(
            WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    void applyMode(int index) {
        Mode chosen = MODES.get(index);
        mode = index;
        step = 0;
        screen.removeCallbacks(animator);
        stopTone();
        setBrightness(chosen.brightness());
        advance();
        showLabel(chosen.name());
        save();
    }

    boolean toggleAudio() {
        audioOn = !audioOn;
        if (audioOn) maxAlarmVolume();
        else stopTone();
        showLabel(audioOn ? "SOUND ON" : "SOUND OFF");
        save();
        return true;
    }

    void save() {
        preferences.edit().putInt("mode", mode).putBoolean("audio", audioOn).apply();
    }

    void advance() {
        Mode current = MODES.get(mode);
        Step frame = current.steps().get(step);
        step = (step + 1) % current.steps().size();
        screen.setBackgroundColor(frame.lit() ? current.color() : BLACK);
        if (audioOn && frame.beep()) beep(current.tone(), frame.duration());
        screen.postDelayed(animator, frame.duration());
    }

    void beep(int frequency, int milliseconds) {
        stopTone();
        int count = SAMPLE_RATE * milliseconds / 1000;
        short[] samples = new short[count];
        for (int index = 0; index < count; index++) {
            double angle = 2 * Math.PI * frequency * index / SAMPLE_RATE;
            samples[index] = (short) (Math.sin(angle) * Short.MAX_VALUE);
        }
        tone = new AudioTrack(ALARM_OUTPUT, MONO_16_BIT, count * 2,
            AudioTrack.MODE_STATIC, AudioManager.AUDIO_SESSION_ID_GENERATE);
        tone.write(samples, 0, count);
        tone.play();
    }

    void stopTone() {
        if (tone == null) return;
        tone.release();
        tone = null;
    }

    void maxAlarmVolume() {
        try {
            AudioManager audio = getSystemService(AudioManager.class);
            int loudest = audio.getStreamMaxVolume(AudioManager.STREAM_ALARM);
            audio.setStreamVolume(AudioManager.STREAM_ALARM, loudest, 0);
        } catch (SecurityException blockedByDoNotDisturb) {
        }
    }

    void setBrightness(float value) {
        var attributes = getWindow().getAttributes();
        attributes.screenBrightness = value;
        getWindow().setAttributes(attributes);
    }

    void showLabel(String text) {
        label.setText(text);
        label.setAlpha(1f);
        label.animate().alpha(0f).setStartDelay(1200).setDuration(400);
    }

    static Step pulse(int milliseconds) { return new Step(true, milliseconds, true); }
    static Step glow(int milliseconds) { return new Step(true, milliseconds, false); }
    static Step dark(int milliseconds) { return new Step(false, milliseconds, false); }

    /** Morse SOS on a 250 ms unit: dot 1, dash 3, gap 1, letter 3, word 7. */
    static List<Step> sos() {
        int dot = 250, dash = 750, gap = 250, letter = 750, word = 1750;
        return List.of(
            pulse(dot), dark(gap), pulse(dot), dark(gap), pulse(dot), dark(letter),
            pulse(dash), dark(gap), pulse(dash), dark(gap), pulse(dash), dark(letter),
            pulse(dot), dark(gap), pulse(dot), dark(gap), pulse(dot), dark(word));
    }
}
