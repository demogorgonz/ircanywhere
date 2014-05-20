/**
 * IRCAnywhere server/serverSession.js
 *
 * @title ServerSession
 * @copyright (c) 2013-2014 http://ircanywhere.com
 * @license GPL v2
 * @author Rodrigo Silveira
 */

var IrcMessage = require('irc-message'),
	_ = require('lodash'),
	Q = require('q');

/**
 * Handles the communication between an IRC client and ircanywhere's IRC server. Instantiated on
 * every new client connection.
 *
 * @param {Object} socket Connection socket to the client
 * @constructor ServerSession
 */
function ServerSession(socket) {
	this.socket = socket;
	this.id = Math.floor(Math.random() * 1e10).toString(10);
	// Random id for this session

	this.welcomed = false;

	this.init();
}

/**
 * Initializes session.
 *
 * @return void
 */
ServerSession.prototype.init = function() {
	var self = this;

	this.socket.on('data', function(data) {
		var lines = data.toString().split("\r\n");
		// One command por line

		lines.pop();
		// last line will be blank, ignore

		lines.forEach(function(line) {
			var message = IrcMessage(line),
				command = message.command.toLowerCase();

			if (self[command]) {
				self[command](message);
				// Handle some events internally
			} else {
				self.onClientMessage(message, command);
				// Handle everything else.
			}
		});
	});
	// Handle data received from client

	this.socket.on('error', function(error) {
		application.logger.log('error', 'error with client connection to IRC server');
		application.handleError(error, false);
		self.socket.end();
	});

	this.socket.on('close', function() {
		process.nextTick(function () {
			self.socket.removeAllListeners();
			delete self.socket;
		});
		// Clean up the socket but give a chance to other close event handlers to run first
	});
};

/**
 * Handles PASS message from client. Stores password for login.
 *
 * @param {Object} message Received message
 */
ServerSession.prototype.pass = function(message) {
	this.password = message.params[0];
	// PASS message should be the first, before USER or NICK.
};

/**
 * Handles NICK message from client. If message arrives before welcome, just store nickname. Otherwise
 * process it.
 *
 * @param {Object} message Received message
 */
ServerSession.prototype.nick = function(message) {
	if (!this.welcomed) {
		this.nickname = message.params[0];
		// first nick, just store it locally.
	} else {
		this.onClientMessage(message, 'nick')
	}
};

/**
 * Handles QUIT message from client. Disconnects the user.
 *
 * @param {Object} message Received message
 */
ServerSession.prototype.quit = function(message) {
	this.disconnectUser()
};

/**
 * Disconnects the socket.
 *
 * @return void
 */
ServerSession.prototype.disconnectUser = function() {
	this.socket.end();
};

/**
 * Handles USER message from client. Start login sequence. Username should contain network information if
 * more then one network is registered. Username with network is in the form:
 *
 * 	user@email.com/networkName
 *
 * @param {Object} message Received message
 */
ServerSession.prototype.user = function(message) {
	var self = this,
		params = message.params[0].split('/'),
		email = params[0],
		network = params[1];

	userManager.loginServerUser(email, self.password)
		.fail(function(error){
			// TODO send a 464 ERR_PASSWDMISMATCH

			application.logger.log('error', 'error logging in user ' + email);
			application.handleError(error, false);
			self.disconnectUser();

			return Q.reject(error);
		})
		.then(function(user) {
			var deferred = Q.defer();

			fibrous.run(function() {
				var networks = networkManager.getClients(),
					keys = Object.keys(networks);

				if (keys.length === 1) {
					self.network = networks[keys[0]];
					// if only one network, choose it
				} else
				{
					self.network = _.find(networks, {name: network});
					if (!self.network) {
						deferred.reject(new Error('Network ' + network + ' not found.'));
						return;
					}
				}

				self.user = user;
				self.email = email;
				self.setup();
				self.sendWelcome()
					.then(deferred.resolve);
			}, application.handleError.bind(application));
			// Fibrous needed for networkManager.getClients

			return deferred.promise
				.fail(function(error){
					application.handleError(error, false);
					self.disconnectUser();

					return Q.reject(error);
				});
		})
		.then(function () {
			self.sendPlayback();
		});
};

/**
 * Sets up client to listen to IRC activity.
 *
 * @return void
 */
ServerSession.prototype.setup = function() {
	var callback = this.handleEvent.bind(this);

	application.ee.on(['events', 'insert'], callback);

	this.socket.on('close', function() {
		application.ee.removeListener(['events', 'insert'], callback);
	}.bind(this));
};

/**
 * Handle IRC events.
 *
 * @param {Object} event Event to handle
 */
ServerSession.prototype.handleEvent =  function(event) {
	var ignore = ['registered', 'lusers', 'motd'];

	if (event.message.clientId === this.id) {
		return;
	}
	// Don't duplicate events.

	if (event.network !== this.network.name) {
		return;
	}
	// Check network

	if (_.contains(ignore, event.type)) {
		return;
	}
	// Is in the ignore list

	this.sendRaw(event.message.raw);
	// Sent to client
};

/**
 * Sends stored welcome message from network to client. Message order is registered, lusers,
 * nick (to set to stored nick), motd and usermode.
 *
 * @return {promise}
 */
ServerSession.prototype.sendWelcome = function () {
	var self = this;

	function sendWelcomeMessagesForNick(rawMessages) {
		function setNick(rawMessage) {
			var message = new IrcMessage(rawMessage);

			message.params[0] = self.nickname;

			return message.toString();
		}

		if (_.isArray(rawMessages)) {
			rawMessages.forEach(function(rawMessage) {
				self.sendRaw(setNick(rawMessage));
			});
		} else {
			self.sendRaw(setNick(rawMessages));
		}
	}

	return eventManager.getEventByType('registered', self.network.name, self.user._id)
		.then(function (event) {
			if (event) {
				sendWelcomeMessagesForNick(event.message.raw);
			}

			return eventManager.getEventByType('lusers', self.network.name, self.user._id);
		})
		.then(function (event) {
			if (event) {
				sendWelcomeMessagesForNick(event.message.raw);
			}

			self.sendRaw(':' + self.nickname + ' NICK :' + self.user.profile.nickname);
			self.nickname = self.user.profile.nickname;

			return eventManager.getEventByType('motd', self.network.name, self.user._id);
		})
		.then(function (event) {
			if (event) {
				sendWelcomeMessagesForNick(event.message.raw);
			}

			return eventManager.getEventByType('usermode', self.network.name, self.user._id);
		})
		.then(function (event) {
			if (event) {
				sendWelcomeMessagesForNick(event.message.raw);
			}

			self.welcomed = true;
		})
		.fail(function (error) {
			application.logger.log('error', 'error registering client to IRC server');
			application.handleError(error, false);
		});
};

/**
 * Sends playback messages to client.
 *
 * @return void
 */
ServerSession.prototype.sendPlayback = function () {
	var self = this,
		channelsSent = {};

	eventManager.getUserPlayback(self.network.name, self.user._id, self.user.lastSeen.toJSON())
		.then(function (events) {
			var deferred = Q.defer();

			events.each(function (err, event) {
				if (err || !event) {
					deferred.reject(err);
					return;
				}

				var message = new IrcMessage(event.message.raw),
					timestamp = new Date(event.message.time),
					channel = message.params[0];

				message.params[1] = '[' + timestamp.toTimeString() + '] ' +
					message.params[1];
				// Prepend timestamp
				// TODO: better format date/time, get user timezone

				if (!channelsSent[channel]) {
					self.sendRaw(':***!ircanywhere@ircanywhere.com PRIVMSG ' + channel + ' :Playback Start...');
					channelsSent[channel] = true;
				}

				self.sendRaw(message.toString());

				deferred.resolve();
			});

			return deferred.promise;
		})
		.then(function () {
			_.each(_.keys(channelsSent), function (channel) {
				self.sendRaw(':***!ircanywhere@ircanywhere.com PRIVMSG ' + channel + ' :Playback End.');
			});

			userManager.updateLastSeen(self.user._id);
		});
};

/**
 * Handles PRIVMSG messages from client. Forwards to ircHandler and to ircFactory.
 *
 * @param {Object} message Received message
 */
ServerSession.prototype.privmsg = function(message) {
	var hostmask = message.parseHostmaskFromPrefix(),
		timestamp = new Date(),
		hostname = (hostmask && hostmask.hostname) || 'none',
		data = {
			nickname: this.nickname,
			username: this.user.ident,
			hostname: hostname,
			target: message.params[0],
			message: message.params[1],
			time: timestamp.toJSON(),
			raw: message.toString(),
			clientId: this.id
		};

	ircHandler.privmsg(Clients[this.network._id.toString()], data);
	// inset in the db

	ircFactory.send(this.network._id.toString(), 'raw', [message.toString()]);
	// send to network

	userManager.updateLastSeen(this.user._id, timestamp);
};

/**
 * Handles all message that do not have a specific handler.
 *
 * @param {Object} message Received message
 * @param {String} command Messages command
 */
ServerSession.prototype.onClientMessage = function(message, command) {
	if (ircHandler[command]) {
		var hostmask = message.parseHostmaskFromPrefix(),
			hostname = (hostmask && hostmask.hostname) || 'none',
			data = {
				nickname: this.nickname,
				username: this.user.ident,
				hostname: hostname,
				target: '*', // TODO: Does this work for all messages?
				message: message.params[1],
				time: new Date().toJSON(),
				raw: message.toString(),
				clientId: this.id
			};

		ircHandler[command](Clients[this.network._id.toString()], data);
	}
	// Check if ircHandler can handle the command

	ircFactory.send(this.network._id.toString(), 'raw', [message.toString()]);
	// send to network

	// TODO: Should update lastseen on some messages.
};

/**
 * Sends a raw message to the client
 *
 * @param {String} rawMessage
 */
ServerSession.prototype.sendRaw = function(rawMessage) {
	this.socket.write(rawMessage + "\r\n");
};

exports.ServerSession = ServerSession;