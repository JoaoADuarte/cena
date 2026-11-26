/**
 * The one rule that never changes: nothing is published without the creator's approval.
 * An approval is tied to the exact file and details that were on screen when "Aprovar" was clicked.
 * The publisher must call `verify` right before uploading; if anything changed since, it refuses.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Everything about the video that the creator approves besides the file itself. */
const metaOf = (video) => JSON.stringify({ title: video.title, metadata: video.data.metadata ?? null, thumbnail: video.data.thumbnail ?? null, schedule: video.data.schedule ?? null });
const hashText = (text) => crypto.createHash("sha256").update(text).digest("hex");

function createApprovals(db) {
  return {
    async approve(video) {
      if (!video.data.finalPath || !fs.existsSync(video.data.finalPath)) throw new Error("O vídeo final não foi encontrado.");
      db.revokeApprovals(video.id);
      db.addApproval(video.id, await hashFile(video.data.finalPath), hashText(metaOf(video)));
    },
    revoke: (videoId) => db.revokeApprovals(videoId),
    current: (videoId) => db.approval(videoId),
    /** Throws unless this exact video, with these exact details, was approved and not changed since. */
    async verify(videoId) {
      const video = db.video(videoId);
      const approval = db.approval(videoId);
      if (!video || !approval || video.status !== "approved") throw new Error("Este vídeo não foi aprovado por você.");
      if (hashText(metaOf(video)) !== approval.meta_hash) throw new Error("Os dados do vídeo mudaram depois da aprovação. Aprove de novo.");
      if ((await hashFile(video.data.finalPath)) !== approval.file_hash) throw new Error("O arquivo do vídeo mudou depois da aprovação. Aprove de novo.");
      return { video, approval };
    },
  };
}

module.exports = { createApprovals };
