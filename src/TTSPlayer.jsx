import React, { useState, useEffect } from "react";

const TTSPlayer = () => {
  const [text, setText] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isStreamingMode, setIsStreamingMode] = useState(true);
  const SAMPLE_RATE_DEFAULT = 44100;
  const TARGET_BATCH_SEC = 0.5;
  // Constants, assumes mono PCM16 data

  const HEADER_SIZE = 44;

  const audioCtxRef = { current: null };
  const nextTimeRef = { current: 0 };
  const pendingPCMRef = { current: [] };
  const pendingLenRef = { current: 0 };
  const carryByteRef = { current: null };
  const headerSkippedRef = { current: false };
  const headerRemainingRef = { current: 0 };

  const [apiUrl, setApiUrl] = useState(() => {
    return localStorage.getItem("ttsApiUrl") || "";
  });

  const [language, setLanguage] = useState(() => {
    return localStorage.getItem("ttsLanguage") || "en";
  });

  const [gender, setGender] = useState(() => {
    return localStorage.getItem("ttsGender") || "female";
  });

  useEffect(() => {
    localStorage.setItem("ttsApiUrl", apiUrl);
    localStorage.setItem("ttsLanguage", language);
    localStorage.setItem("ttsGender", gender);
  }, [apiUrl, language, gender]);

  const clearSettings = () => {
    setApiUrl("");
    setLanguage("en");
    setGender("female");
    localStorage.removeItem("ttsApiUrl");
    localStorage.removeItem("ttsLanguage");
    localStorage.removeItem("ttsGender");
  };

  const stopAudio = () => {
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {}
      audioCtxRef.current = null;
    }
    nextTimeRef.current = 0;
    pendingPCMRef.current = [];
    pendingLenRef.current = 0;
    carryByteRef.current = null;
    headerSkippedRef.current = false;
    headerRemainingRef.current = 0;
    setIsPlaying(false);
  };

  const playStreamingAudio = async (response) => {
    if (!audioCtxRef.current) {
      const headerSampleRate =
        Number(response.headers.get("X-Audio-Sample-Rate")) ||
        SAMPLE_RATE_DEFAULT;

      audioCtxRef.current = new (window.AudioContext ||
        window.webkitAudioContext)({
        latencyHint: "interactive",
        sampleRate: headerSampleRate,
      });

      const primingLead = Math.max(
        0.05,
        audioCtxRef.current.baseLatency || 0.05
      );
      nextTimeRef.current = audioCtxRef.current.currentTime + primingLead;
    }

    const reader = response.body.getReader();
    const headerSampleRate = audioCtxRef.current.sampleRate;

    let sampleRemainder = 0;
    let lastChunkTime = performance.now(); 

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      // measure time gap between this chunk and the previous one
      const now = performance.now();
      const gap = now - lastChunkTime;
      console.log(`[Chunk] Gap since last chunk: ${gap.toFixed(2)} ms`);
      lastChunkTime = now;

      let chunk = value;

      if (carryByteRef.current !== null) {
        const merged = new Uint8Array(1 + chunk.byteLength);
        merged[0] = carryByteRef.current;
        merged.set(chunk, 1);
        chunk = merged;
        carryByteRef.current = null;
      }

      let startOffset = 0;
      let byteLength = chunk.byteLength;

      if (!headerSkippedRef.current) {
        if (byteLength >= 12) {
          const riff = new TextDecoder().decode(chunk.slice(0, 4));
          const wave = new TextDecoder().decode(chunk.slice(8, 12));
          if (riff === "RIFF" && wave === "WAVE") {
            if (byteLength >= HEADER_SIZE) {
              startOffset += HEADER_SIZE;
              byteLength -= HEADER_SIZE;
              headerSkippedRef.current = true;
            } else {
              headerRemainingRef.current = HEADER_SIZE - byteLength;
              continue;
            }
          } else {
            headerSkippedRef.current = true;
          }
        } else {
          continue;
        }
      } else if (headerRemainingRef.current > 0) {
        if (byteLength > headerRemainingRef.current) {
          startOffset += headerRemainingRef.current;
          byteLength -= headerRemainingRef.current;
          headerRemainingRef.current = 0;
          headerSkippedRef.current = true;
        } else {
          headerRemainingRef.current -= byteLength;
          continue;
        }
      }

      if (byteLength <= 0) continue;

      if ((byteLength & 1) === 1) {
        carryByteRef.current = chunk[startOffset + byteLength - 1];
        byteLength -= 1;
      }
      if (byteLength <= 0) continue;

      const float32Chunk = convertPCM16ToFloat32(
        chunk.buffer,
        chunk.byteOffset + startOffset,
        byteLength
      );
      if (float32Chunk.length === 0) continue;

      // Push into pending buffer
      pendingPCMRef.current.push(float32Chunk);
      pendingLenRef.current += float32Chunk.length;

      // Calculate exact batch size with remainder handling
      let exactSamples = headerSampleRate * TARGET_BATCH_SEC + sampleRemainder;
      const samplesPerBatch = Math.floor(exactSamples);
      sampleRemainder = exactSamples - samplesPerBatch;

      if (pendingLenRef.current >= samplesPerBatch) {
        flushBatch(audioCtxRef.current, headerSampleRate, samplesPerBatch);
      }
    }

    // Flush any remaining audio at the end
    flushBatch(audioCtxRef.current, headerSampleRate, pendingLenRef.current);
  };
  const playFullAudio = async (response) => {
    const reader = response.body.getReader();
    const chunks = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      chunks.push(value);
      totalLength += value.length;
    }

    const combined = new Uint8Array(totalLength);
    let pos = 0;
    for (const chunk of chunks) {
      combined.set(chunk, pos);
      pos += chunk.length;
    }

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = audioCtx;

    const float32Data = convertPCM16ToFloat32(
      combined.buffer,
      44,
      combined.byteLength - 44
    );
    const buffer = audioCtx.createBuffer(
      1,
      float32Data.length,
      audioCtx.sampleRate
    );
    buffer.copyToChannel(float32Data, 0);

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);

    console.log(
      `Playing full audio at ${formatTimestamp(
        audioCtx.currentTime
      )} - Duration: ${formatTimestamp(buffer.duration)}`
    );
    source.start();

    source.onended = () => {
      console.log(
        `Full audio finished at ${formatTimestamp(audioCtx.currentTime)}`
      );
      try {
        source.disconnect();
      } catch {}
    };
  };

  const flushBatch = (ctx, sampleRate, samplesToConsume) => {
    // console.log({
    //   ctx:ctx,
    //   sampleRate,
    //   samplesToConsume
    // })
    if (!samplesToConsume || pendingLenRef.current < samplesToConsume) return;

    const out = new Float32Array(samplesToConsume);
    let pos = 0;
    let remaining = samplesToConsume;

    while (remaining > 0 && pendingPCMRef.current.length > 0) {
      const chunk = pendingPCMRef.current[0];
      if (chunk.length <= remaining) {
        out.set(chunk, pos);
        pos += chunk.length;
        remaining -= chunk.length;
        pendingPCMRef.current.shift();
      } else {
        out.set(chunk.subarray(0, remaining), pos);
        pendingPCMRef.current[0] = chunk.subarray(remaining);
        pos += remaining;
        remaining = 0;
      }
    }

    pendingLenRef.current -= samplesToConsume;

    const buf = ctx.createBuffer(1, out.length, sampleRate);
    buf.copyToChannel(out, 0);

    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(ctx.destination);

    // Schedule with small safety margin
    const when = Math.max(nextTimeRef.current, ctx.currentTime );
    source.start(when);

    source.onended = () => {
      try {
        source.disconnect();
      } catch {}
    };

    // Always advance relative to scheduled start time
    nextTimeRef.current = when + buf.duration;
  };

  const formatTimestamp = (timeInSeconds) => {
    const hours = Math.floor(timeInSeconds / 3600);
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    const milliseconds = Math.floor((timeInSeconds % 1) * 1000);

    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}:${milliseconds
      .toString()
      .padStart(3, "0")}`;
  };

  // Corrected PCM16 to Float32 conversion
  const convertPCM16ToFloat32 = (
    buffer,
    byteOffset,
    byteLength,
    isLittleEndian = true
  ) => {
    const alignedLength = byteLength & ~1;
    if (alignedLength <= 0) {
      return new Float32Array(0);
    }
    const dv = new DataView(buffer, byteOffset, alignedLength);
    const out = new Float32Array(alignedLength / 2);

    for (let i = 0; i < out.length; i++) {
      // Correctly get the signed 16-bit integer and normalize
      out[i] = dv.getInt16(i * 2, isLittleEndian) / 32768;
    }
    return out;
  };

  const playAudio = async () => {
    if (!text.trim()) {
      alert("Please enter some text");
      return;
    }

    stopAudio(); // cleanup
    setIsPlaying(true);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          language,
          gender,
        }),
      });

      if (!response.ok || !response.body) {
        alert("Failed to get audio stream");
        setIsPlaying(false);
        return;
      }

      if (isStreamingMode) {
        await playStreamingAudio(response);
      } else {
        await playFullAudio(response);
      }

      setIsPlaying(false);
    } catch (error) {
      console.error("Audio streaming error:", error);
      alert("Error during audio streaming: " + error.message);
      setIsPlaying(false);
    }
  };

  return (
    <div
      style={{
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        padding: "30px",
        maxWidth: "800px",
        margin: "0 auto",
        backgroundColor: "#f8f9fa",
        borderRadius: "12px",
        boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
      }}
    >
      <h2
        style={{
          color: "#1a73e8",
          marginBottom: "24px",
          fontSize: "28px",
          fontWeight: "600",
        }}
      >
        Text to Speech Player
      </h2>

      <div style={{ marginBottom: "24px" }}>
        <div
          style={{
            marginBottom: "20px",
            backgroundColor: "white",
            padding: "20px",
            borderRadius: "8px",
            boxShadow: "0 2px 4px rgba(0, 0, 0, 0.05)",
          }}
        >
          <label
            style={{
              display: "block",
              marginBottom: "8px",
              color: "#444",
              fontWeight: "500",
            }}
          >
            API URL
          </label>
          <div style={{ display: "flex", gap: "10px" }}>
            <input
              type="text"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="Enter TTS API URL"
              style={{
                padding: "10px 12px",
                width: "100%",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "14px",
                transition: "border-color 0.2s",
                outline: "none",
              }}
              disabled={isPlaying}
            />
            <button
              onClick={clearSettings}
              disabled={isPlaying || !apiUrl}
              style={{
                padding: "10px 16px",
                backgroundColor: isPlaying || !apiUrl ? "#ddd" : "#dc3545",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: isPlaying || !apiUrl ? "not-allowed" : "pointer",
                transition: "background-color 0.2s",
                fontWeight: "500",
                minWidth: "120px",
              }}
            >
              Clear Settings
            </button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "20px",
            marginBottom: "20px",
          }}
        >
          <div
            style={{
              backgroundColor: "white",
              padding: "20px",
              borderRadius: "8px",
              boxShadow: "0 2px 4px rgba(0, 0, 0, 0.05)",
            }}
          >
            <label
              style={{
                display: "block",
                marginBottom: "8px",
                color: "#444",
                fontWeight: "500",
              }}
            >
              Language
            </label>
            <input
              type="text"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="Enter language code (e.g. en, hi, fr)"
              disabled={isPlaying}
              style={{
                padding: "10px 12px",
                width: "100%",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "14px",
              }}
            />
          </div>

          <div
            style={{
              backgroundColor: "white",
              padding: "20px",
              borderRadius: "8px",
              boxShadow: "0 2px 4px rgba(0, 0, 0, 0.05)",
            }}
          >
            <label
              style={{
                display: "block",
                marginBottom: "8px",
                color: "#444",
                fontWeight: "500",
              }}
            >
              Voice Gender
            </label>
            <input
              type="text"
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              placeholder="Enter gender (female/male)"
              disabled={isPlaying}
              style={{
                padding: "10px 12px",
                width: "100%",
                border: "1px solid #ddd",
                borderRadius: "6px",
                fontSize: "14px",
              }}
            />
          </div>
        </div>

        <div
          style={{
            backgroundColor: "white",
            padding: "20px",
            borderRadius: "8px",
            boxShadow: "0 2px 4px rgba(0, 0, 0, 0.05)",
            marginBottom: "20px",
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              color: "#444",
              fontWeight: "500",
            }}
          >
            <input
              type="checkbox"
              checked={isStreamingMode}
              onChange={(e) => setIsStreamingMode(e.target.checked)}
              disabled={isPlaying}
              style={{
                width: "16px",
                height: "16px",
              }}
            />
            Streaming Mode
            <span
              style={{
                fontSize: "14px",
                color: "#666",
                fontWeight: "normal",
              }}
            >
              ({isStreamingMode ? "Play chunk by chunk" : "Play complete audio"}
              )
            </span>
          </label>
        </div>

        <div
          style={{
            backgroundColor: "white",
            padding: "20px",
            borderRadius: "8px",
            boxShadow: "0 2px 4px rgba(0, 0, 0, 0.05)",
          }}
        >
          <label
            style={{
              display: "block",
              marginBottom: "8px",
              color: "#444",
              fontWeight: "500",
            }}
          >
            Text to Convert
          </label>
          <textarea
            rows={5}
            placeholder="Paste your text here..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isPlaying}
            style={{
              padding: "12px",
              width: "100%",
              border: "1px solid #ddd",
              borderRadius: "6px",
              fontSize: "14px",
              resize: "vertical",
              minHeight: "120px",
              fontFamily: "inherit",
            }}
          />
        </div>
      </div>

      <button
        onClick={playAudio}
        disabled={isPlaying || !apiUrl}
        style={{
          padding: "12px 24px",
          backgroundColor: isPlaying || !apiUrl ? "#ddd" : "#1a73e8",
          color: "white",
          border: "none",
          borderRadius: "6px",
          cursor: isPlaying || !apiUrl ? "not-allowed" : "pointer",
          fontSize: "16px",
          fontWeight: "500",
          transition: "background-color 0.2s",
          width: "100%",
        }}
      >
        {isPlaying ? "Playing..." : "Convert to Speech"}
      </button>
    </div>
  );
};

export default TTSPlayer;
