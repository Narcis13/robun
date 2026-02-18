export class GroqTranscriptionProvider {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.GROQ_API_KEY ?? "";
  }

  async transcribe(filePath: string): Promise<string> {
    if (!this.apiKey) return "";

    const file = Bun.file(filePath);
    if (!(await file.exists())) return "";

    const formData = new FormData();
    formData.append("file", file);
    formData.append("model", "whisper-large-v3");

    try {
      const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: formData,
      });
      if (!resp.ok) return "";
      const data = (await resp.json()) as { text?: string };
      return data.text ?? "";
    } catch {
      return "";
    }
  }
}
