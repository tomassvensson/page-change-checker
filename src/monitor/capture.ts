import type { Page } from 'playwright';

import { imagesReady, pageValidity } from './journal.js';
import {
  acceptedObservations,
  compareSignatures,
  confirmEvidence,
  evaluateEvidence
} from './rules.js';
import type { MonitorRule, Observation, PageEvidence, Signature } from './rules.js';
import { semanticSnapshot } from './semantic.js';
import { maskSignature } from './visual.js';

export interface CaptureOptions {
  navigate: () => Promise<number | null>;
  authenticate: (url: string, text: string) => string | null;
  title?: (title: string) => string;
  timeoutMs?: number;
  preScreenshotWaitMs?: number;
  requireLoadedImages?: boolean;
  minimumLoadedImages?: number;
  imageReadinessTimeoutMs?: number;
  imageDecodeTimeoutMs?: number;
  imageLoadAttempts?: number;
  eagerLoadImages?: boolean;
  reloadOnIncompleteImages?: boolean;
  confirmationWaitMs?: number;
}
export interface CaptureBundle {
  evidence: PageEvidence;
  screenshot?: Buffer;
  signature?: Signature;
}

class CaptureConsistencyError extends Error {}

async function validate(page: Page, status: number | null, options: CaptureOptions) {
  if (status !== null && status >= 400) throw new Error(`HTTP ${status}; evidence not compared`);
  const text = await page.locator('body').innerText({ timeout: options.timeoutMs ?? 30000 });
  const title = options.title?.(await page.title()) ?? (await page.title());
  const error = options.authenticate(page.url(), text) ?? pageValidity({ title, text });
  if (error) throw new Error(error);
}

/** Image readiness is independent of the optional extra wait. Every reload is
 * the same authenticated/HTTP-validated navigation, never a raw page.reload(). */
export async function settleImages(page: Page, status: number | null, options: CaptureOptions) {
  await validate(page, status, options);
  if (options.requireLoadedImages) {
    const attempts = options.imageLoadAttempts ?? 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (options.eagerLoadImages)
        await page.evaluate(async () => {
          for (const img of Array.from(document.images)) img.loading = 'eager';
          const original = scrollY;
          for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
            scrollTo(0, y);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          scrollTo(0, original);
        });
      let ready = false;
      try {
        await page.waitForFunction(
          (minimum) => {
            const visible = Array.from(document.images).filter(
              (img) => img.getClientRects().length && getComputedStyle(img).visibility !== 'hidden'
            );
            return (
              visible.length >= minimum &&
              visible.every((img) => img.complete && img.naturalWidth > 0)
            );
          },
          options.minimumLoadedImages ?? 0,
          { timeout: options.imageReadinessTimeoutMs ?? 30000 }
        );
        const states = await page.evaluate(async (timeout) => {
          const images = Array.from(document.images).filter(
            (img) => img.getClientRects().length && getComputedStyle(img).visibility !== 'hidden'
          );
          return Promise.all(
            images.map(async (img) => {
              let decoded = false,
                timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  img.decode(),
                  new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('decode timeout')), timeout);
                  })
                ]);
                decoded = true;
              } catch {
                /* reported as failed readiness, not silently captured */
              } finally {
                clearTimeout(timer);
              }
              return { complete: img.complete, naturalWidth: img.naturalWidth, decoded };
            })
          );
        }, options.imageDecodeTimeoutMs ?? 10000);
        ready = imagesReady(
          states.filter((s) => s.complete && s.naturalWidth > 0 && s.decoded).length,
          states.length,
          options.minimumLoadedImages ?? 0,
          true
        );
      } catch {
        /* validated retry below */
      }
      if (ready) break;
      if (attempt + 1 >= attempts || !options.reloadOnIncompleteImages)
        throw new Error('Images did not finish loading; baseline retained');
      status = await options.navigate();
      await validate(page, status, options);
    }
  }
  if (options.preScreenshotWaitMs) await page.waitForTimeout(options.preScreenshotWaitMs);
  await validate(page, status, options);
  return status;
}

export async function signatureFromPng(
  page: Page,
  buffer: Buffer,
  title: string,
  rule: {
    sampleWidth?: number;
    maxSampleHeight?: number;
    ignoreTopPixels?: number;
    ignoreRegions?: { x: number; y: number; width: number; height: number }[];
  } = {}
): Promise<Signature> {
  const result = await page.evaluate(
    async ({ png, title, width, maxHeight }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const height = Math.min(maxHeight, Math.max(1, Math.round((img.height * width) / img.width)));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      let rgb = '';
      for (let i = 0; i < data.length; i += 4)
        rgb += String.fromCharCode(data[i], data[i + 1], data[i + 2]);
      return { title, width, height, pixels: btoa(rgb), sourceHeight: img.height };
    },
    {
      png: buffer.toString('base64'),
      title,
      width: rule.sampleWidth ?? 96,
      maxHeight: rule.maxSampleHeight ?? 384
    }
  );
  const regions = [...(rule.ignoreRegions ?? [])];
  if (rule.ignoreTopPixels)
    regions.push({
      x: 0,
      y: 0,
      width: 1,
      height: Math.min(1, rule.ignoreTopPixels / result.sourceHeight)
    });
  return { ...maskSignature(result, regions), title };
}

async function captureOnce(
  page: Page,
  rules: MonitorRule[],
  status: number | null,
  options: CaptureOptions
): Promise<CaptureBundle> {
  status = await settleImages(page, status, options);
  const title = options.title?.(await page.title()) ?? (await page.title());
  // Scoped screenshots can scroll the document and trigger lazy content. Take
  // them before reading text, then require the final full-page PNG to agree.
  const signatures: Record<string, Signature> = {};
  for (const rule of rules) {
    if (rule.kind !== 'visualSnapshot' && rule.kind !== 'imageSnapshot') continue;
    try {
      const locator = page.locator(rule.selector ?? 'body').first();
      await locator.waitFor({
        state: 'visible',
        timeout: rule.timeoutMs ?? options.timeoutMs ?? 30000
      });
      signatures[rule.id] = await signatureFromPng(
        page,
        await locator.screenshot({ animations: 'disabled' }),
        title,
        rule
      );
    } catch {
      /* missing scoped input is diagnosed below */
    }
  }
  const text = await page.locator('body').innerText();
  const evidence: PageEvidence = {
    title,
    text,
    finalUrl: page.url(),
    httpStatus: status,
    at: new Date().toISOString(),
    authentication: 'validated',
    inputs: {}
  };
  evidence.challengeDetected =
    (await page
      .locator('#challenge-running:visible,[data-testid="challenge-page"]:visible')
      .count()) > 0;
  for (const rule of rules) {
    try {
      if (
        rule.kind === 'mustContainText' ||
        rule.kind === 'statMustEqual' ||
        rule.kind === 'statEqualsTriggers'
      )
        continue;
      const locator = page.locator(rule.selector ?? 'body').first();
      await locator.waitFor({
        state: 'visible',
        timeout: rule.timeoutMs ?? options.timeoutMs ?? 30000
      });
      if (rule.kind === 'visibleTextSnapshot')
        evidence.inputs[rule.id] = { value: await locator.innerText() };
      else if (rule.kind === 'selectorContentSnapshot')
        evidence.inputs[rule.id] = { value: await semanticSnapshot(locator, rule) };
      else {
        if (!signatures[rule.id]) throw new Error('Missing image input');
        evidence.inputs[rule.id] = { signature: signatures[rule.id] };
      }
    } catch {
      evidence.inputs[rule.id] = {
        error: 'Required element was not found or could not be captured.'
      };
    }
  }
  evidence.expectedContentPresent = Object.values(evidence.inputs).some(
    (input) => input.value !== undefined || input.signature !== undefined
  );
  const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled' });
  if (page.url() !== evidence.finalUrl || (await page.locator('body').innerText()) !== text)
    throw new CaptureConsistencyError(
      'Page changed during capture; inconsistent evidence rejected'
    );
  return { evidence, screenshot, signature: await signatureFromPng(page, screenshot, title) };
}

/** One bounded recapture handles lazy/scroll-triggered content. Authentication,
 * HTTP status and image readiness are revalidated; unstable evidence is never
 * committed and arbitrary failures are not hidden by this retry. */
export async function capturePage(
  page: Page,
  rules: MonitorRule[],
  status: number | null,
  options: CaptureOptions
): Promise<CaptureBundle> {
  try {
    return await captureOnce(page, rules, status, options);
  } catch (error) {
    if (!(error instanceof CaptureConsistencyError)) throw error;
    await page.waitForTimeout(1000);
    return captureOnce(page, rules, status, options);
  }
}

/** Production orchestration, reused unchanged by local deployment and fixtures. */
export async function runRuleCheck(
  page: Page,
  rules: MonitorRule[],
  baseline: Record<string, Observation>,
  options: CaptureOptions
) {
  const first = await capturePage(page, rules, await options.navigate(), options);
  let decisions = evaluateEvidence(rules, first.evidence, baseline),
    bundle = first;
  const confirmationNeeded = decisions.some(
    (d) => d.valid && (d.initial || d.rebaselined || d.changed || d.active)
  );
  if (confirmationNeeded) {
    await page.waitForTimeout(options.confirmationWaitMs ?? 10000);
    bundle = await capturePage(page, rules, await options.navigate(), options);
    decisions = confirmEvidence(rules, first.evidence, bundle.evidence, baseline);
  } else decisions = decisions.map((d) => ({ ...d, confirmed: d.valid }));
  return {
    ...bundle,
    firstEvidence: first.evidence,
    decisions,
    observations: acceptedObservations(decisions),
    confirmedAll: decisions.every((d) => d.valid && d.confirmed),
    changed: decisions.some((d) => d.changed && d.confirmed)
  };
}

/** Original PNG is untouched; a separate image marks small changed sample areas. */
export async function annotateChanges(
  page: Page,
  png: Buffer,
  previous: Signature,
  current: Signature,
  maximumRatio = 0.25
): Promise<Buffer | null> {
  const comparison = compareSignatures(previous, current);
  if (
    !comparison.changed ||
    comparison.changedRatio > maximumRatio ||
    !comparison.changedSampleIndices.length
  )
    return null;
  const base64 = await page.evaluate(
    async ({ png, indices, width, height }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      ctx.fillStyle = 'rgba(255,0,0,0.30)';
      ctx.strokeStyle = 'red';
      ctx.lineWidth = 2;
      for (const index of indices) {
        const x = ((index % width) * img.width) / width,
          y = (Math.floor(index / width) * img.height) / height;
        ctx.fillRect(x, y, img.width / width, img.height / height);
        ctx.strokeRect(x, y, img.width / width, img.height / height);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    },
    {
      png: png.toString('base64'),
      indices: comparison.changedSampleIndices,
      width: current.width,
      height: current.height
    }
  );
  return Buffer.from(base64, 'base64');
}
