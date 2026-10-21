import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Logger } from 'pino';
import type { EmailAttachment } from '../adapters/email/interface.js';

export const TWO_MEGABYTES = 2 * 1024 * 1024; // 2,097,152 bytes

export function getAudioMimeType(extension: string): string {
  const ext = extension.toLowerCase();
  switch (ext) {
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.amr':
      return 'audio/amr';
    case '.wav':
      return 'audio/wav';
    case '.ogg':
    case '.opus':
    default:
      return 'audio/ogg';
  }
}

/**
 * Compresses an audio file using ffmpeg to a speech-optimized low-bitrate MP3 (24kbps mono).
 * Returns an EmailAttachment if successful, or null if ffmpeg fails or is not available.
 */
export async function compressAudioWithFfmpeg(
  inputPath: string,
  logger?: Logger
): Promise<EmailAttachment | null> {
  const outputPath = `${inputPath}.compressed.mp3`;

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-codec:a',
        'libmp3lame',
        '-b:a',
        '24k',
        '-ac',
        '1',
        outputPath,
      ]);

      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
    });

    if (fs.existsSync(outputPath)) {
      const compressedContent = fs.readFileSync(outputPath);
      try {
        fs.unlinkSync(outputPath);
      } catch {
        // Ignore temporary unlink error
      }

      logger?.info(
        { inputPath, compressedSize: compressedContent.length },
        'Audio successfully compressed via ffmpeg'
      );

      return {
        filename: 'voice-message.mp3',
        content: compressedContent,
        contentType: 'audio/mpeg',
      };
    }
  } catch (err) {
    logger?.warn(
      { err: (err as Error).message, inputPath },
      'ffmpeg transcode failed or not available; falling back to original audio attachment'
    );
    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch {
        // Ignore cleanup error
      }
    }
  }

  return null;
}

/**
 * Prepares audio attachments from a disk path.
 * If file size <= 2MB, attaches directly without ffmpeg.
 * If file size > 2MB, gates and runs through ffmpeg to compress.
 */
export async function prepareAudioAttachment(
  filePath: string,
  logger?: Logger
): Promise<EmailAttachment[]> {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const stat = fs.statSync(filePath);
    const originalExt = path.extname(filePath).toLowerCase() || '.ogg';
    const contentType = getAudioMimeType(originalExt);

    // 1. Gate: 2MB or less -> attach directly without transcoding
    if (stat.size <= TWO_MEGABYTES) {
      const content = fs.readFileSync(filePath);
      return [
        {
          filename: `voice-message${originalExt}`,
          content,
          contentType,
        },
      ];
    }

    // 2. Over 2MB -> run through ffmpeg to compress
    logger?.info(
      { filePath, sizeBytes: stat.size },
      'Audio exceeds 2MB gate; running through ffmpeg compression on server'
    );

    const compressed = await compressAudioWithFfmpeg(filePath, logger);
    if (compressed) {
      return [compressed];
    }

    // 3. Fallback: attach original if ffmpeg is unavailable or fails
    const content = fs.readFileSync(filePath);
    return [
      {
        filename: `voice-message${originalExt}`,
        content,
        contentType,
      },
    ];
  } catch (err) {
    logger?.error(
      { err: (err as Error).message, filePath },
      'Failed to prepare audio attachment'
    );
    return [];
  }
}
