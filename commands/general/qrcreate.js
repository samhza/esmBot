const qrcode = require("qrcode");
const stream = require("stream");
const Command = require("../../classes/command.js");

class QrCreateCommand extends Command {
  async run() {
    if (this.args.length === 0) return "You need to provide some text to generate a QR code!";
    this.client.sendChannelTyping(this.message.channel.id);
    const writable = new stream.PassThrough();
    qrcode.toFileStream(writable, this.content, { margin: 1 });
    const file = await this.streamToBuf(writable);
    return {
      file: file,
      name: "qr.png"
    };
  }

  streamToBuf(stream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on("data", (chunk) => {
        chunks.push(chunk);
      });
      stream.once("error", (error) => {
        reject(error);
      });
      stream.once("end", () => {
        resolve(Buffer.concat(chunks));
      });
    });
  }

  static description = "Generates a QR code";
  static arguments = ["[text]"];
}

module.exports = QrCreateCommand;