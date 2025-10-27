require('dotenv').config();

const { DefinePlugin, EnvironmentPlugin } = require('@rspack/core');
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { TsCheckerRspackPlugin } = require('ts-checker-rspack-plugin');

const config = {
    entry: {
        index: './src/index.ts'
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        clean: true
    },
    devServer: {
        host: "localhost",
        port: 3000,
        open: ["/"],
        historyApiFallback: true
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
        new HtmlWebpackPlugin({
            template: './index.html'
        }),
        new TsCheckerRspackPlugin(),
        new DefinePlugin({
            'process.env.ASSETS_URL': JSON.stringify(process.env.ASSETS_URL)
        }),
        new EnvironmentPlugin({
            ENGINE: "auto",
            SCALE_FACTOR: "1"
        }),
    ],
    experiments: {
        css: true,
        topLevelAwait: true
    }
};

module.exports = config;
