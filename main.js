'use strict';
var CryptoJS = require('crypto-js');
var express = require('express');
var bodyParser = require('body-parser');
var WebSocket = require('ws');

var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;

// 初始化的p2p服务器，为websocket协议
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];

/**
 * 一个区块类
 */
class Block {
  /**
   * 区块构造函数
   * @param index 区块指针
   * @param previousHash 上一个区块的hash
   * @param timestamp 时间戳
   * @param data 区块附带的数据
   * @param hash 当前区块的hash
   */
  constructor(index, previousHash, timestamp, data, hash) {
    this.index = index;
    this.previousHash = previousHash.toString();
    this.timestamp = timestamp;
    this.data = data;
    this.hash = hash.toString();
  }
}

var sockets = [];

/**
 * 消息体的结构，使用websocket通信
 * @type {{QUERY_LATEST: number, QUERY_ALL: number, RESPONSE_BLOCKCHAIN: number}}
 */
var MessageType = {
  QUERY_LATEST: 0, // 查询最新的区块链
  QUERY_ALL: 1, // 获取所有的区块
  RESPONSE_BLOCKCHAIN: 2
};

/**
 * 获取创世区块
 * @returns {Block}
 */
var getGenesisBlock = () => {
  return new Block(
    0,
    '0',
    1465154705,
    'my genesis block!!',
    '816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7'
  );
};

/**
 * 创世区块链
 * @type {[null]}
 */
var blockchain = [getGenesisBlock()];

/**
 * 初始化http服务器
 */
var initHttpServer = () => {
  // 搭建一个express服务器
  var app = express();
  // 解析http body
  app.use(bodyParser.json());

  // 获取所有的区块链
  app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));

  // 挖矿, 产生新的区块
  app.post('/mineBlock', (req, res) => {
    // 生产新的区块
    var newBlock = generateNextBlock(req.body.data);

    // 加入到区块链
    addBlock(newBlock);

    // 广播最新的区块
    broadcast(responseLatestMsg());
    console.log('block added: ' + JSON.stringify(newBlock));
    res.send();
  });

  // 获取p2p网络
  app.get('/peers', (req, res) => {
    res.send(
      sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort)
    );
  });

  // 添加p2p
  app.post('/addPeer', (req, res) => {
    connectToPeers([req.body.peer]);
    res.send();
  });

  // 监听端口
  app.listen(http_port, () =>
    console.log('Listening http on port: ' + http_port)
  );
};

/**
 * 初始化p2p服务器，基于websocket
 */
var initP2PServer = () => {
  var server = new WebSocket.Server({ port: p2p_port });
  server.on('connection', ws => initConnection(ws));
  console.log('listening websocket p2p port on: ' + p2p_port);
};

/**
 * 初始化连接
 * @param ws websocket链接
 */
var initConnection = ws => {
  // 记录当前已链接的socket
  sockets.push(ws);
  // 初始化信息接收器
  initMessageHandler(ws);
  // 初始化错误信息接收器
  initErrorHandler(ws);
  write(ws, queryChainLengthMsg());
};

/**
 * 初始化连接的操作
 * @param ws
 */
var initMessageHandler = ws => {
  // 监听链接收到的消息
  ws.on('message', data => {
    // 反序列化接收到的消息字符串
    var message = JSON.parse(data);
    console.log('Received message' + JSON.stringify(message));
    // 根据消息类型进行对应的处理
    switch (message.type) {
      // 获取最新的区块
      case MessageType.QUERY_LATEST:
        write(ws, responseLatestMsg());
        break;
      // 获取整个区块链
      case MessageType.QUERY_ALL:
        write(ws, responseChainMsg());
        break;
      /**
       * 如果收到来自其他节点的区块消息
       */
      case MessageType.RESPONSE_BLOCKCHAIN:
        handleBlockchainResponse(message);
        break;
    }
  });
};

/**
 * 初始化连接的错误处理函数
 * @param ws
 */
var initErrorHandler = ws => {
  var closeConnection = ws => {
    console.log('connection failed to peer: ' + ws.url);
    sockets.splice(sockets.indexOf(ws), 1);
  };
  // 如果链接关闭或发生错误，都会把链接从本地中移除
  ws.on('close', () => closeConnection(ws));
  ws.on('error', () => closeConnection(ws));
};

/**
 * 生成下一个区块
 * @param blockData
 * @returns {Block}
 */
var generateNextBlock = blockData => {
  var previousBlock = getLatestBlock(); // 当前区块链中最新的区块
  var nextIndex = previousBlock.index + 1; // 下一个区块的索引
  var nextTimestamp = new Date().getTime() / 1000; // unix时间戳

  // 根据区块的特性，计算唯一的hash
  var nextHash = calculateHash(
    nextIndex,
    previousBlock.hash,
    nextTimestamp,
    blockData
  );

  // 返回新的区块
  return new Block(
    nextIndex,
    previousBlock.hash,
    nextTimestamp,
    blockData,
    nextHash
  );
};

/**
 * 计算区块的hash值
 * @param block
 */
var calculateHashForBlock = block => {
  return calculateHash(
    block.index,
    block.previousHash,
    block.timestamp,
    block.data
  );
};

/**
 * 根据传入的参数计算hash值
 * @param index
 * @param previousHash
 * @param timestamp
 * @param data
 * @returns {string}
 */
var calculateHash = (index, previousHash, timestamp, data) => {
  return CryptoJS.SHA256(index + previousHash + timestamp + data).toString();
};

/**
 * 添加新区块
 * @param newBlock
 */
var addBlock = newBlock => {
  // 如果区块是合法的
  // 那么把区块加入到链中
  if (isValidNewBlock(newBlock, getLatestBlock())) {
    blockchain.push(newBlock);
  }
};

/**
 * 验证是否是合法的新区块
 * @param newBlock 新区块
 * @param previousBlock 上一个区块
 * @returns {boolean}
 */
var isValidNewBlock = (newBlock, previousBlock) => {
  // 如果这两个区块是不连续的: index值不相邻
  // 那么是不合法的新区块
  if (previousBlock.index + 1 !== newBlock.index) {
    console.log('invalid index');
    return false;
  } else if (previousBlock.hash !== newBlock.previousHash) {
    // 如果这两个区块是不连续的: hash值上下不对等
    // 那么是不合法的新区块
    console.log('invalid previoushash');
    return false;
  } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
    // 如果计算出来的新区块的hash值，与区块的hash不一致: 说明区块信息被篡改
    // 那么是不合法的新区块
    console.log(
      typeof newBlock.hash + ' ' + typeof calculateHashForBlock(newBlock)
    );
    console.log(
      'invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash
    );
    return false;
  }

  // 上面不合法的情况都没有，说明是合法的
  return true;
};

/**
 * 链接到p2p网络
 * @param newPeers
 */
var connectToPeers = newPeers => {
  /**
   * 逐个创建p2p链接
   */
  newPeers.forEach(peer => {
    // 使用Websocket协议
    var ws = new WebSocket(peer);
    // 链接成功后，进行初始化操作
    ws.on('open', () => initConnection(ws));
    ws.on('error', () => {
      console.log('connection failed');
    });
  });
};

/**
 * 处理区块的返回值
 * @param message
 */
var handleBlockchainResponse = message => {
  /**
   * 反序列化收到的区块链
   * 并且根据index从小到大排序
   * @type {Array.<T>}
   */
  var receivedBlocks = JSON.parse(message.data).sort(
    (b1, b2) => b1.index - b2.index
  );
  // 收到的最新区块
  var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
  // 当前本地的最新区块
  var latestBlockHeld = getLatestBlock();

  // 如果收到的最新区块的索引，大于本地的最新区块
  // 那么可能会进行同步操作
  if (latestBlockReceived.index > latestBlockHeld.index) {
    console.log(
      'blockchain possibly behind. We got: ' +
        latestBlockHeld.index +
        ' Peer got: ' +
        latestBlockReceived.index
    );
    // 如果本地区块的hash，是接受到的最新区块的上一个hash
    // 即: 最新本地区块 > 接受到的最新区块
    if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
      console.log('We can append the received block to our chain');
      // 那么就认可这个区块， 加入到本地的区块链中
      blockchain.push(latestBlockReceived);
      // 并且广播当前获取的最新区块
      broadcast(responseLatestMsg());
    } else if (receivedBlocks.length === 1) {
      // 如果接受到的区块链长度为1, 那么这个区块链是刚刚创建的，没有从p2p网络中同步区块
      console.log('We have to query the chain from our peer');
      // 广播给其他人，同步区块链
      broadcast(queryAllMsg());
    } else {
      // 如果新生成的链是这样的
      // 最新本地区块 > 区块A > 区块 > B > ... > 接受到的最新区块
      // 那么整条链就落后了，需要替换掉整块链
      console.log('Received blockchain is longer than current blockchain');
      replaceChain(receivedBlocks);
    }
  } else {
    // 接收到的区块链可能比本地的区块链还要旧，那么什么都不用做
    console.log(
      'received blockchain is not longer than current blockchain. Do nothing'
    );
  }
};

/**
 * 替换新的区块
 * @param newBlocks 区块链
 */
var replaceChain = newBlocks => {
  // 如果是合法的区块链， 并且新的区块链的长度>本地区块链的长度
  if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
    console.log(
      'Received blockchain is valid. Replacing current blockchain with received blockchain'
    );
    // 替换掉当前的区块链
    blockchain = newBlocks;
    // 广播最新的区块
    broadcast(responseLatestMsg());
  } else {
    console.log('Received blockchain invalid');
  }
};

/**
 * 检验是否是合法的区块链
 * @param blockchainToValidate 区块链
 * @returns {boolean}
 */
var isValidChain = blockchainToValidate => {
  // 如果区块链的第一个区块，不是创世区块
  // 那么这条链是不合法的
  if (
    JSON.stringify(blockchainToValidate[0]) !==
    JSON.stringify(getGenesisBlock())
  ) {
    return false;
  }
  // 以为创世区块作为一条初始链
  var tempBlocks = [blockchainToValidate[0]];

  // 遍历区块链
  for (var i = 1; i < blockchainToValidate.length; i++) {
    // 逐个去检验，是否是合法区块
    // 如果是，则把这个区块加入到 tempBlocks中
    // 以此推演
    if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
      tempBlocks.push(blockchainToValidate[i]);
    } else {
      return false;
    }
  }
  return true;
};

/**
 * 获取最新的区块
 */
var getLatestBlock = () => blockchain[blockchain.length - 1];

// 生成一个消息体，获取最新的区块
var queryChainLengthMsg = () => ({ type: MessageType.QUERY_LATEST });

// 生产一个消息体, 获取整个区块链
var queryAllMsg = () => ({ type: MessageType.QUERY_ALL });

/**
 * 获取整个区块链，并且包裹成消息体
 */
var responseChainMsg = () => ({
  type: MessageType.RESPONSE_BLOCKCHAIN,
  data: JSON.stringify(blockchain)
});

/**
 * 获取最新的区块, 并且包裹成消息体
 */
var responseLatestMsg = () => ({
  type: MessageType.RESPONSE_BLOCKCHAIN,
  data: JSON.stringify([getLatestBlock()])
});

/**
 * 写入消息
 * @param ws
 * @param message
 */
var write = (ws, message) => ws.send(JSON.stringify(message));

/**
 * websocket广播消息
 * @param message
 */
var broadcast = message => sockets.forEach(socket => write(socket, message));

/**
 * 1. 根据初始化连接到p2p网络
 * 2. 创建http服务器
 * 3. 初始化p2p服务器
 */
connectToPeers(initialPeers);
initHttpServer();
initP2PServer();
