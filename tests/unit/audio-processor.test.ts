import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  prepareAudioAttachment,
  compressAudioWithFfmpeg,
  getAudioMimeType,
  TWO_MEGABYTES,
} from '../../src/domain/audio-processor.js';
import { createLogger } from '../../src/observability/logger.js';

describe('Audio Processor (2MB Gate & Attachment Preparation)', () => {
  it('maps audio file extensions to standard MIME types', () => {
    assert.equal(getAudioMimeType('.mp3'), 'audio/mpeg');
    assert.equal(getAudioMimeType('.m4a'), 'audio/mp4');
    assert.equal(getAudioMimeType('.amr'), 'audio/amr');
    assert.equal(getAudioMimeType('.wav'), 'audio/wav');
    assert.equal(getAudioMimeType('.ogg'), 'audio/ogg');
    assert.equal(getAudioMimeType('.opus'), 'audio/ogg');
    assert.equal(getAudioMimeType(''), 'audio/ogg');
  });

  it('attaches audio <= 2MB directly without transcoding', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-proc-small-'));
    const testFile = path.join(tmpDir, 'audio-123.ogg');
    const fakeSmallAudio = Buffer.alloc(500 * 1024, 0x42); // 500 KB (< 2MB)
    fs.writeFileSync(testFile, fakeSmallAudio);

    try {
      const attachments = await prepareAudioAttachment(testFile);
      assert.equal(attachments.length, 1);
      assert.equal(attachments[0]?.filename, 'voice-message.ogg');
      assert.equal(attachments[0]?.contentType, 'audio/ogg');
      assert.equal(Buffer.compare(attachments[0]?.content as Buffer, fakeSmallAudio), 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('gates audio > 2MB and falls back to original attachment when ffmpeg fails or is unavailable', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-proc-large-'));
    const testFile = path.join(tmpDir, 'audio-large.ogg');
    const fakeLargeAudio = Buffer.alloc(2.5 * 1024 * 1024, 0x43); // 2.5 MB (> 2MB)
    fs.writeFileSync(testFile, fakeLargeAudio);

    const logger = createLogger({ level: 'silent' });

    try {
      // Since dummy buffer isn't valid audio bytes for ffmpeg or ffmpeg may not be installed on host,
      // it must cleanly fallback to attaching the original audio buffer without throwing or crashing
      const attachments = await prepareAudioAttachment(testFile, logger);
      assert.equal(attachments.length, 1);
      assert.ok(attachments[0]?.filename.startsWith('voice-message'));
      assert.ok((attachments[0]?.content as Buffer).length > 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty array when audio file does not exist', async () => {
    const attachments = await prepareAudioAttachment('/nonexistent/path/file.ogg');
    assert.deepEqual(attachments, []);
  });
});
