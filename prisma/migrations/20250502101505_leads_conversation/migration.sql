/*
  Warnings:

  - You are about to drop the column `leadEmailId` on the `LeadAttachment` table. All the data in the column will be lost.
  - You are about to drop the `LeadEmail` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `conversationEmailId` to the `LeadAttachment` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "LeadAttachment" DROP CONSTRAINT "LeadAttachment_leadEmailId_fkey";

-- DropForeignKey
ALTER TABLE "LeadEmail" DROP CONSTRAINT "LeadEmail_leadId_fkey";

-- AlterTable
ALTER TABLE "LeadAttachment" DROP COLUMN "leadEmailId",
ADD COLUMN     "conversationEmailId" TEXT NOT NULL;

-- DropTable
DROP TABLE "LeadEmail";

-- CreateTable
CREATE TABLE "LeadConversation" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationEmail" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "from" JSONB NOT NULL,
    "to" JSONB NOT NULL,
    "cc" JSONB NOT NULL,
    "bcc" JSONB NOT NULL,
    "hasAttachments" BOOLEAN NOT NULL,
    "receivedDateTime" TIMESTAMP(3) NOT NULL,
    "isIncoming" BOOLEAN NOT NULL,
    "isThreadHead" BOOLEAN NOT NULL DEFAULT false,
    "inReplyTo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadConversation_conversationId_key" ON "LeadConversation"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationEmail_emailId_key" ON "ConversationEmail"("emailId");

-- AddForeignKey
ALTER TABLE "LeadAttachment" ADD CONSTRAINT "LeadAttachment_conversationEmailId_fkey" FOREIGN KEY ("conversationEmailId") REFERENCES "ConversationEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadConversation" ADD CONSTRAINT "LeadConversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("lead_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEmail" ADD CONSTRAINT "ConversationEmail_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "LeadConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
