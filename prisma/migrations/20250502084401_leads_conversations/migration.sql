/*
  Warnings:

  - Added the required column `conversation_id` to the `LeadEmail` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "LeadEmail" ADD COLUMN     "conversation_id" TEXT NOT NULL,
ADD COLUMN     "inReplyTo" TEXT,
ADD COLUMN     "isThreadHead" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "messageId" TEXT;

-- CreateIndex
CREATE INDEX "LeadEmail_conversation_id_idx" ON "LeadEmail"("conversation_id");
