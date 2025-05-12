-- AlterTable
ALTER TABLE "AutoReplyConfig" ADD COLUMN     "emailTemplateId" TEXT;

-- AddForeignKey
ALTER TABLE "AutoReplyConfig" ADD CONSTRAINT "AutoReplyConfig_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
