import { config } from '../config.js';

/**
 * Public URL of an uploaded avatar. Relative ("/api/uploads/avatars/…") unless PUBLIC_URL is set;
 * clients prefix relative URLs with the API origin they already use.
 */
export const avatarUrl = (file) => (file ? `${config.publicUrl}/api/uploads/avatars/${file}` : null);
