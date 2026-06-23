require('dotenv').config();

const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { TsCheckerRspackPlugin } = require('ts-checker-rspack-plugin');
const Dotenv = require('dotenv-webpack');

const devHost = process.env.HOST || 'localhost';
const devPort = process.env.PORT || 19000;
const devHot = process.env.DEV_HOT === '1';

// Dev-only OCBT pool GPU cross-check page. Excluded from production builds (gh-pages)
// so the public demo never ships the test harness. Gated on the build mode only:
// .env sets NODE_ENV=production for DefinePlugin, so process.env.NODE_ENV is not a
// reliable signal here. `rspack serve` => development; `rspack build` => production.
const isProd = (argv) => !argv || argv.mode === 'production';

const config = (env, argv) => ({
    entry: {
        index: './src/index.ts',
        ...(isProd(argv)
            ? {}
            : { ocbtTest: './src/systems/lod/cbt/ocbt/ocbt_pool_gpu_test_main.ts' })
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        clean: true
    },
    devServer: {
        host: devHost,
        port: devPort,
        historyApiFallback: true,
        hot: devHot,
        liveReload: false,
        client: {
            reconnect: false,
            overlay: false,
        },
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [
            {
                test: /\.(ts|js)$/,
                loader: 'builtin:swc-loader',
                exclude: /node_modules/
            },
            {
                test: /\.(glsl|wgsl|vert|frag|vs|fs)$/,
                use: ['ts-shader-loader'],
                exclude: /node_modules/
            }
        ]
    },
    plugins: [
        // chunks pins each page to its own entry (default injects every chunk into
        // every HTML page once there is more than one entry).
        new HtmlWebpackPlugin({
            template: './index.html',
            chunks: ['index']
        }),
        ...(isProd(argv)
            ? []
            : [
                  new HtmlWebpackPlugin({
                      template: './ocbt-test.html',
                      filename: 'ocbt-test.html',
                      chunks: ['ocbtTest']
                  })
              ]),
        new TsCheckerRspackPlugin(),
        new Dotenv({
            path: './.env',
            systemvars: true,
            allowEmptyValues: true,
        }),
    ],
    experiments: {
        css: true,
        topLevelAwait: true,
        lazyCompilation: false
    }
});

module.exports = config;
