require('dotenv').config();

const { DefinePlugin } = require('@rspack/core');
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { TsCheckerRspackPlugin } = require('ts-checker-rspack-plugin');

const config = {
    entry: {
        index: './src/Main.ts'
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        publicPath: '/World42/',
        clean: true
    },
    devServer: {
        port: 3000,
        open: ["/World42/"],
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
        })
    ],
    experiments: {
        css: true,
        topLevelAwait: true
    }
};

module.exports = config;
