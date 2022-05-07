import { randomBytes } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { rm, mkdir, stat } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, extname, resolve as resolvePath } from "path";
import type { Readable, Writable } from "stream";
import { MeterError } from "@remix-run/server-runtime";
import type { UploadHandler } from "@remix-run/server-runtime";
// @ts-expect-error
import * as streamSlice from "stream-slice";

import { readableStreamFromStream, readableStreamToString } from "../stream";

export type FileUploadHandlerFilterArgs = {
  filename: string;
  contentType: string;
  name: string;
};

export type FileUploadHandlerPathResolverArgs = {
  filename: string;
  contentType: string;
  name: string;
};

/**
 * Chooses the path of the file to be uploaded. If a string is not
 * returned the file will not be written.
 */
export type FileUploadHandlerPathResolver = (
  args: FileUploadHandlerPathResolverArgs
) => string | undefined;

export type FileUploadHandlerOptions = {
  /**
   * Avoid file conflicts by appending a count on the end of the filename
   * if it already exists on disk. Defaults to `true`.
   */
  avoidFileConflicts?: boolean;
  /**
   * The directory to write the upload.
   */
  directory?: string | FileUploadHandlerPathResolver;
  /**
   * The name of the file in the directory. Can be a relative path, the directory
   * structure will be created if it does not exist.
   */
  file?: FileUploadHandlerPathResolver;
  /**
   * The maximum upload size allowed. If the size is exceeded an error will be thrown.
   * Defaults to 3000000B (3MB).
   */
  maxFileSize?: number;
  /**
   *
   * @param filename
   * @param mimetype
   * @param encoding
   */
  filter?(args: FileUploadHandlerFilterArgs): boolean | Promise<boolean>;
};

let defaultFilePathResolver: FileUploadHandlerPathResolver = ({ filename }) => {
  let ext = filename ? extname(filename) : "";
  return "upload_" + randomBytes(4).readUInt32LE(0) + ext;
};

async function uniqueFile(filepath: string) {
  let ext = extname(filepath);
  let uniqueFilepath = filepath;

  for (
    let i = 1;
    await stat(uniqueFilepath)
      .then(() => true)
      .catch(() => false);
    i++
  ) {
    uniqueFilepath =
      (ext ? filepath.slice(0, -ext.length) : filepath) +
      `-${new Date().getTime()}${ext}`;
  }

  return uniqueFilepath;
}

export function createFileUploadHandler({
  directory = tmpdir(),
  avoidFileConflicts = true,
  file = defaultFilePathResolver,
  filter,
  maxFileSize = 3000000,
}: FileUploadHandlerOptions): UploadHandler {
  return async ({ name, filename, contentType, data }) => {
    if (filter && !(await filter({ name, filename, contentType }))) {
      return undefined;
    }

    let dir =
      typeof directory === "string"
        ? directory
        : directory({ name, filename, contentType });

    if (!dir) {
      return undefined;
    }

    let filedir = resolvePath(dir);
    let path =
      typeof file === "string" ? file : file({ name, filename, contentType });

    if (!path) {
      return undefined;
    }

    let filepath = resolvePath(filedir, path);

    if (avoidFileConflicts) {
      filepath = await uniqueFile(filepath);
    }

    await mkdir(dirname(filepath), { recursive: true }).catch(() => {});

    let writeFileStream = createWriteStream(filepath);
    let size = 0;
    let deleteFile = false;
    try {
      for await (let chunk of data) {
        size += chunk.length;
        if (size > maxFileSize) {
          deleteFile = true;
          throw new MeterError(name, maxFileSize);
        }
        writeFileStream.write(chunk);
      }
    } finally {
      writeFileStream.close();
      if (deleteFile) {
        await rm(filepath).catch(() => {});
      }
    }

    return new NodeOnDiskFile(filepath, size, contentType);
  };
}

export class NodeOnDiskFile implements File {
  name: string;
  lastModified: number = 0;
  webkitRelativePath: string = "";

  constructor(
    private filepath: string,
    public size: number,
    public type: string,
    private slicer?: Writable & Readable
  ) {
    this.name = basename(filepath);
  }

  slice(start?: number, end?: number, contentType?: string): Blob {
    start = typeof start !== "undefined" ? start : 0;
    end = typeof end !== "undefined" ? end : this.size;
    return new NodeOnDiskFile(
      this.filepath,
      end - start,
      this.type,
      streamSlice.slice(start, end)
    );
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    let stream: Readable = createReadStream(this.filepath);
    if (this.slicer) {
      stream = stream.pipe(this.slicer);
    }

    return new Promise((resolve, reject) => {
      let buf: any[] = [];
      stream.on("data", (chunk) => buf.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(buf)));
      stream.on("error", (err) => reject(err));
    });
  }

  stream(): ReadableStream<any>;
  stream(): NodeJS.ReadableStream;
  stream(): ReadableStream<any> | NodeJS.ReadableStream {
    let stream: Readable = createReadStream(this.filepath);
    if (this.slicer) {
      stream = stream.pipe(this.slicer);
    }
    return readableStreamFromStream(stream);
  }

  text(): Promise<string> {
    let stream: Readable = createReadStream(this.filepath);
    if (this.slicer) {
      stream = stream.pipe(this.slicer);
    }

    return readableStreamToString(readableStreamFromStream(stream));
  }

  get [Symbol.toStringTag]() {
    return "File";
  }
}
