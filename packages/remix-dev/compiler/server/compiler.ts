import { builtinModules } from "module";
import * as esbuild from "esbuild";
import {
  type NodePolyfillsOptions,
  nodeModulesPolyfillPlugin,
} from "esbuild-plugins-node-modules-polyfill";

import { type Manifest } from "../../manifest";
import { loaders } from "../utils/loaders";
import { cssModulesPlugin } from "../plugins/cssModuleImports";
import { cssSideEffectImportsPlugin } from "../plugins/cssSideEffectImports";
import { vanillaExtractPlugin } from "../plugins/vanillaExtract";
import { cssFilePlugin } from "../plugins/cssImports";
import { absoluteCssUrlsPlugin } from "../plugins/absoluteCssUrlsPlugin";
import { deprecatedRemixPackagePlugin } from "../plugins/deprecatedRemixPackage";
import { emptyModulesPlugin } from "../plugins/emptyModules";
import { mdxPlugin } from "../plugins/mdx";
import { serverAssetsManifestPlugin } from "./plugins/manifest";
import { serverBareModulesPlugin } from "./plugins/bareImports";
import { serverEntryModulePlugin } from "./plugins/entry";
import { serverRouteModulesPlugin } from "./plugins/routes";
import { externalPlugin } from "../plugins/external";
import type * as Channel from "../../channel";
import type { Context } from "../context";
import type { LazyValue } from "../lazyValue";
import { cssBundlePlugin } from "../plugins/cssBundlePlugin";
import { writeMetafile } from "../analysis";

type Compiler = {
  // produce ./build/index.js
  compile: () => Promise<esbuild.OutputFile[]>;
  cancel: () => Promise<void>;
  dispose: () => Promise<void>;
};

const createEsbuildConfig = (
  ctx: Context,
  refs: {
    manifestChannel: Channel.Type<Manifest>;
    lazyCssBundleHref: LazyValue<string | undefined>;
  }
): esbuild.BuildOptions => {
  let stdin: esbuild.StdinOptions | undefined;
  let entryPoints: string[] | undefined;

  if (ctx.config.serverEntryPoint) {
    entryPoints = [ctx.config.serverEntryPoint];
  } else {
    stdin = {
      contents: ctx.config.serverBuildTargetEntryModule,
      resolveDir: ctx.config.rootDirectory,
      loader: "ts",
    };
  }

  let plugins: esbuild.Plugin[] = [
    deprecatedRemixPackagePlugin(ctx),
    cssBundlePlugin(refs),
    cssModulesPlugin(ctx, { outputCss: false }),
    vanillaExtractPlugin(ctx, { outputCss: false }),
    cssSideEffectImportsPlugin(ctx),
    cssFilePlugin(ctx),
    absoluteCssUrlsPlugin(),
    externalPlugin(/^https?:\/\//, { sideEffects: false }),
    mdxPlugin(ctx),
    emptyModulesPlugin(ctx, /\.client(\.[jt]sx?)?$/),
    serverRouteModulesPlugin(ctx),
    serverEntryModulePlugin(ctx),
    serverAssetsManifestPlugin(refs),
    serverBareModulesPlugin(ctx),
    externalPlugin(/^node:.*/, { sideEffects: false }),
  ];

  if (ctx.config.serverNodeBuiltinsPolyfill) {
    // These unimplemented polyfills throw an error at runtime if they're used.
    // It's also possible that they'll be provided by the host environment (e.g.
    // Cloudflare provides an "async_hooks" polyfill) so it's better to avoid
    // them by default when server polyfills are enabled. If consumers want an
    // unimplemented polyfill for some reason, they can explicitly pass a list
    // of desired polyfills instead. This list was manually populated by looking
    // for unimplemented browser polyfills in the jspm-core repo:
    // https://github.com/jspm/jspm-core/tree/main/nodelibs/browser
    let unimplemented = [
      "async_hooks", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/async_hooks.js
      "child_process", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/child_process.js
      "cluster", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/cluster.js
      "dgram", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/dgram.js
      "dns", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/dns.js
      "dns/promises", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/dns/promises.js
      "http2", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/http2.js
      "net", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/net.js
      "readline", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/readline.js
      "repl", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/repl.js
      "tls", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/tls.js
      "v8", // https://github.com/jspm/jspm-core/blob/main/nodelibs/browser/v8.js
    ];

    // These modules were polyfilled as empty modules by the plugin we used
    // prior to esbuild-plugins-node-modules-polyfill, so keep them as empty
    // in the defaults in 1.19.0.  For v2 we'll stop doing any polyfilling by
    // default and leave it entirely up to the user.
    let empty = ["fs", "crypto", "dns", "dgram", "cluster", "repl", "tls"];

    let defaultPolyfillOptions: NodePolyfillsOptions = {
      modules: builtinModules.reduce(
        (acc, mod) =>
          Object.assign(acc, {
            [mod]: empty.includes(mod) ? "empty" : !unimplemented.includes(mod),
          }),
        {}
      ),
    };

    plugins.unshift(
      nodeModulesPolyfillPlugin(
        ctx.config.serverNodeBuiltinsPolyfill === true
          ? defaultPolyfillOptions
          : {
              // Ensure only "modules" option is passed to the plugin
              modules: ctx.config.serverNodeBuiltinsPolyfill.modules,
            }
      )
    );
  }

  return {
    absWorkingDir: ctx.config.rootDirectory,
    stdin,
    entryPoints,
    outfile: ctx.config.serverBuildPath,
    conditions: ctx.config.serverConditions,
    platform: ctx.config.serverPlatform,
    format: ctx.config.serverModuleFormat,
    treeShaking: true,
    // The type of dead code elimination we want to do depends on the
    // minify syntax property: https://github.com/evanw/esbuild/issues/672#issuecomment-1029682369
    // Dev builds are leaving code that should be optimized away in the
    // bundle causing server / testing code to be shipped to the browser.
    // These are properly optimized away in prod builds today, and this
    // PR makes dev mode behave closer to production in terms of dead
    // code elimination / tree shaking is concerned.
    minifySyntax: true,
    minify: ctx.options.mode === "production" && ctx.config.serverMinify,
    mainFields: ctx.config.serverMainFields,
    target: "node14",
    loader: loaders,
    bundle: true,
    logLevel: "silent",
    // As pointed out by https://github.com/evanw/esbuild/issues/2440, when tsconfig is set to
    // `undefined`, esbuild will keep looking for a tsconfig.json recursively up. This unwanted
    // behavior can only be avoided by creating an empty tsconfig file in the root directory.
    tsconfig: ctx.config.tsconfigPath,
    sourcemap: ctx.options.sourcemap, // use linked (true) to fix up .map file
    // The server build needs to know how to generate asset URLs for imports
    // of CSS and other files.
    assetNames: "_assets/[name]-[hash]",
    publicPath: ctx.config.publicPath,
    define: {
      "process.env.NODE_ENV": JSON.stringify(ctx.options.mode),
      // TODO: remove in v2
      "process.env.REMIX_DEV_SERVER_WS_PORT": JSON.stringify(
        ctx.config.devServerPort
      ),
      "process.env.REMIX_DEV_ORIGIN": JSON.stringify(
        ctx.options.REMIX_DEV_ORIGIN ?? ""
      ),
      // TODO: remove in v2
      "process.env.REMIX_DEV_HTTP_ORIGIN": JSON.stringify(
        ctx.options.REMIX_DEV_ORIGIN ?? ""
      ),
    },
    jsx: "automatic",
    jsxDev: ctx.options.mode !== "production",
    plugins,
  };
};

export const create = async (
  ctx: Context,
  refs: {
    manifestChannel: Channel.Type<Manifest>;
    lazyCssBundleHref: LazyValue<string | undefined>;
  }
): Promise<Compiler> => {
  let compiler = await esbuild.context({
    ...createEsbuildConfig(ctx, refs),
    write: false,
    metafile: true,
  });
  let compile = async () => {
    let { outputFiles, metafile } = await compiler.rebuild();
    writeMetafile(ctx, "metafile.server.json", metafile);
    return outputFiles;
  };
  return {
    compile,
    cancel: compiler.cancel,
    dispose: compiler.dispose,
  };
};
