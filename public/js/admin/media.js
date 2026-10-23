// Uploads to the Supabase "media" bucket. Photos are resized in the browser first
// so a salesperson's 12 MB phone photo becomes a ~300 KB web image.
import { sb, uuid } from '../core.js';

const BUCKET = 'media';

export async function resizeImage(file, maxSide = 1920, quality = 0.85) {
  if (!/^image\/(jpeg|png|webp|heic|heif)/i.test(file.type) || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6 && file.type === 'image/jpeg') return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file; // browser can't decode (e.g. HEIC on desktop) - upload original
  }
}

// bucket 'internal' is private (team-only files such as history reports): no public URL is returned.
export async function uploadFile(dealershipId, folder, file, bucket = BUCKET) {
  const ext = (file.name.match(/\.(\w{1,5})$/) || [, file.type.split('/')[1] || 'bin'])[1].toLowerCase();
  const path = `${dealershipId}/${folder}/${uuid()}.${ext}`;
  const { error } = await sb.storage.from(bucket).upload(path, file, {
    cacheControl: '31536000', upsert: false, contentType: file.type || undefined,
  });
  if (error) throw error;
  if (bucket !== BUCKET) return { path, url: null };
  const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
  return { path, url: data.publicUrl };
}

export async function removeFile(path, bucket = BUCKET) {
  if (!path) return;
  await sb.storage.from(bucket).remove([path]);
}
