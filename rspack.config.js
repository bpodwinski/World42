require('dotenv').config();

const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { TsCheckerRspackPlugin } = require('ts-checker-rspack-plugin');
const Dotenv = require('dotenv-webpack');

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
        new Dotenv({
            path: './.env',
            systemvars: true,
            allowEmptyValues: true,
        }),
    ],
    experiments: {
        css: true,
        topLevelAwait: true
    }
};

module.exports = config;
