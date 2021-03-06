var assert = require('assert');
var passgen = require('password-hash-and-salt');
var when = require('when');

module.exports = {
  updatePassword: updatePassword,
  getUserByEmailPassword: getUserByEmailPassword,
  getAccessToken: getAccessToken,
  getUserByID: getUserByID,
  getUserByEmail: getUserByEmail,
  getUsersBySicksenseId: getUsersBySicksenseId,
  getSicksenseIDByEmail: getSicksenseIDByEmail,
  getUserJSON: getUserJSON,
  getDevices: getDevices,
  getDefaultDevice: getDefaultDevice,
  setDevice: setDevice,
  clearDevices: clearDevices,
  formattedUser: formattedUser,
  removeDefaultUserDevice: removeDefaultUserDevice,
  verify: verify,
  doesSicksenseIDExist: doesSicksenseIDExist
};

function updatePassword(sicksenseId, newPassword, shouldClearAccessToken) {
  var user;
  return when.promise(function(resolve, reject) {
    // Validate user.
    return DBService.select('sicksense', '*', [{ field: 'id = $', value: sicksenseId }])
      .then(function(result) {
        assert.notEqual(result.rows.length, 0);
        return result.rows[0];
      })
      // Update password.
      .then(function(sicksenseID) {
        passgen(newPassword).hash(sails.config.session.secret, function(err, hashedPassword) {
          var values = [{ field: 'password = $', value: hashedPassword }];
          var conditions = [{ field: 'id = $', value: sicksenseId }];
          DBService.update('sicksense', values, conditions)
            .then(function(result) {

              // Clear access tokens.
              if (shouldClearAccessToken) {
                AccessTokenService.clearAllBySicksenseId(sicksenseId)
                  .then(function () {
                    resolve();
                  })
                  .catch(function (err) {
                    reject(err);
                  });
              }
              else {
                resolve();
              }
            })
            .catch(function(err) {
              reject(err);
            });
        });
      })
      .catch(function(err) {
        reject(err);
      })
  });
}

function getUserByEmailPassword(client, email, password) {
  return when.promise(function(resolve, reject) {
    passgen(password).hash(sails.config.session.secret, function(err, hashedPassword) {
      client.query(
        'SELECT * FROM users WHERE email=$1 AND password=$2',
        [ email, hashedPassword ],
        function(err, result) {
          if (err) {
            err.status = 500;
            reject(err);
            return;
          }

          if (result.rows.length === 0) {
            var error = new Error("อีเมลหรือรหัสผ่านของคุณไม่ถูกต้อง");
            error.status = 403;
            reject(error);
            return;
          }

          resolve(result.rows[0]);
        }
      );
    });
  });
}

function getUserByID(client, id) {
  return when.promise(function(resolve, reject) {
    client.query('SELECT * FROM users WHERE id=$1::int', [ id ], function(err, result) {
      if (err) return reject(err);
      if (result.rows.length === 0) return reject(new Error("ไม่พบผู้ใช้นี้ในระบบ"));

      resolve(result.rows[0]);
    });
  });
}

function getUserByEmail(client, email) {
  return when.promise(function(resolve, reject) {
    client.query('SELECT * FROM users WHERE email=$1', [ email ], function(err, result) {
      if (err) return reject(err);
      if (result.rows.length === 0) return reject('ไม่พบผู้ใช้นี้ในระบบ');

      resolve(result.rows[0]);
    });
  });
}

function getUsersBySicksenseId(sicksenseId) {
  return when.promise(function (resolve, reject) {
    DBService.select('sicksense_users', 'user_id', [
        { field: 'sicksense_id = $', value: sicksenseId }
      ])
      .then(function (result) {
        return when.map(result.rows, function(row) {
          return { id: row.user_id };
        });
      })
      .then(function (users) {
        resolve(users);
      })
      .catch(function (err) {
        reject(err);
      });
  });
}

function getSicksenseIDByEmail(email) {
  return when.promise(function (resolve, reject) {
    DBService.select('sicksense', '*', [
        { field: 'email = $', value: email.toLowerCase() }
      ])
      .then(function (result) {
        if (result.rows.length === 0) return reject(new Error('ไม่พบผู้ใช้นี้ในระบบ'));
        delete result.rows[0].password;
        resolve(result.rows[0]);
      })
      .catch(function (err) {
        reject(err);
      });
  });
}

function getAccessToken(client, userId, refresh) {
  return when.promise(function(resolve, reject) {
    // ORM first :P (ignore `client`).
    AccessToken.findOne({
      userId: userId
    }).exec(function(err, accessToken) {
      if (err) return reject(err);
      if (!accessToken) {
        if (refresh) {
          AccessTokenService.refresh(userId)
            .then(function(accessToken) {
              resolve(accessToken);
            })
            .catch(function(err) {
              reject(err);
            });
        }
        else {
          var error = new Error("Access token ไม่ถูกต้อง");
          error.status = 404;
          return reject(error);
        }
      }
      else {
        resolve(accessToken);
      }
    });
  });
}

function getUserJSON(userId) {
  var user, formattedUser, sicksenseID;
  return when.promise(function (resolve, reject) {
    return DBService.select('users', '*', [
        { field: 'id = $', value: userId }
      ])
      .then(function (result) {
        if (result.rows.length === 0) return reject('User not found.');
        user = result.rows[0];
      })
      .then(function () {
        formattedUser = UserService.formattedUser(user);
      })
      .then(function () {
        return DBService.select('accesstoken', '*', [
            { field: '"userId" = $', value: user.id }
          ])
          .then(function (result) {
            if (result.rows.length > 0) {
              formattedUser.accessToken = result.rows[0].token;
            }
          })
          .catch(function (err) {
            reject(err);
          });
      })
      .then(function () {
        return UserService.getDefaultDevice(user)
          .then(function (device) {
            if (device) {
              formattedUser.deviceToken = device.id
            }
          })
          .catch(function (err) {
            reject(err);
          });
      })
      .then(function () {
        var joinTable = 'sicksense_users su LEFT JOIN sicksense s ON su.sicksense_id = s.id';
        return DBService.select(joinTable, '*', [
            { field: 'su.user_id = $', value: user.id }
          ]);
      })
      .then(function (result) {
        if (result.rows.length === 0) return resolve(formattedUser);
        sicksenseID = result.rows[0];
        formattedUser.email = sicksenseID.email;
        formattedUser.sicksenseId = sicksenseID.id;
        formattedUser.isVerified = sicksenseID.is_verify;
        resolve(formattedUser);
      })
      .catch(function (err) {
        reject(err);
      });
  });
}

function formattedUser(user, extra) {
  extra = extra || {};
  var formattedUser = _.assign({
    id: user.id,
    email: user.email,
    tel: user.tel,
    gender: user.gender,
    birthYear: user.birthYear,
    address: {
      subdistrict: user.subdistrict,
      district: user.district,
      city: user.city
    },
    location: {
      longitude: user.longitude,
      latitude: user.latitude
    },
    platform: user.platform,
    isVerified: user.is_verify || null,
    sicksenseId: user.sicksense_id || null
  }, extra);
  return formattedUser;
}

function setDevice(user, device) {
  // Find if this device already linked with someone.
  var existingDevice;

  return when.promise(function (resolve, reject) {
    var now = (new Date()).getTime();
    return pgconnect()
      .then(function (conn) {
        sails.log.debug('[ReportService:setDevice]', now);
        return when.promise(function (resolve, reject) {
          var query = "SELECT * FROM devices WHERE id = $1";
          var values = [ device.id ];

          conn.client.query(query, values, function (err, result) {
            conn.done();
            sails.log.debug('[ReportService:setDevice]', now);

            if (err) return reject(err);

            existingDevice = result.rows[0];
            resolve();
          });
        });
      })
      .then(function () {
        if (existingDevice) {
          device.user_id = user.id;
          device = _.extend(existingDevice, device);

          // Do update.
          var updates = _.map(_.keys(device), function (key) {
            return {
              field: '"' + key + '" = $',
              value: device[key]
            };
          });
          var conditions = [
            { field: 'id = $', value: device.id }
          ];

          return DBService.update('devices', updates, conditions);
        }
        else {
          device = _.extend({
            platform: 'doctormeios',
            subscribePushNoti: true,
            subscribePushNotiType: 0
          }, device);

          // Do insert
          var data = [
            { field: 'id',                      value: device.id },
            { field: 'platform',                value: device.platform },
            { field: 'user_id',                 value: user.id },
            { field: 'subscribe_pushnoti',      value: device.subscribePushNoti },
            { field: 'subscribe_pushnoti_type', value: device.subscribePushNotiType },
            { field: '"createdAt"',             value: new Date() },
            { field: '"updatedAt"',             value: new Date() }
          ];

          return DBService.insert('devices', data);
        }
      })
      .then(function (result) {
        resolve(result.rows[0]);
      })
      .catch(function (err) {
        reject(err);
      });
  });
}

function removeDefaultUserDevice(user) {
  return getDevices(user)
    .then(function (devices) {
      if (devices.length > 0) {
        return removeDevice(devices[0].id);
      }
      else {
        return when.resolve();
      }
    });
}

function removeDevice(device_id) {
  return when.promise(function (resolve, reject) {
    return DBService.delete('devices', [
      { field: 'id = $', value: device_id }
    ])
    .then(function (result) {
      resolve(result.rows[0]);
    })
    .catch(function (err) {
      reject(err);
    });
  });
}

function clearDevices(user) {
  return DBService.delete('devices', [
    { field: 'user_id = $', value: user.id }
  ]);
}

function getDevices(user) {
  return when.promise(function (resolve, reject) {

    pgconnect()
      .then(function (conn) {
        conn.client.query("SELECT * FROM devices WHERE user_id = $1", [ user.id ], function (err, result) {
          conn.done();
          if (err) return reject(err);

          resolve(result.rows);
        });
      })
      .catch(function (err) {
        reject(err);
      });

  });
}

function getDefaultDevice(user) {
  return getDevices(user)
    .then(function (devices) {
      return when.promise(function (resolve) {
        resolve(devices[0]);
      });
    });
}

function getDevice(device_id) {
  return when.promise(function (resolve, reject) {

    pgconnect()
      .then(function (conn) {
        conn.client.query("SELECT * FROM devices WHERE id = $1", [ device_id ], function (err, result) {
          conn.done();
          if (err) return reject(err);

          resolve(result.rows[0]);
        });
      })
      .catch(function (err) {
        reject(err);
      });

  });
}

function subscribePushNoti(user, device_id) {
  return setSubscribePushNoti(user, device_id, true);
}

function unsubscribePushNoti(user, device_id) {
  return setSubscribePushNoti(user, device_id, false);
}

function setSubscribePushNoti(user, device_id, subscribe) {
  return when.promise(function (resolve, reject) {
    var updates = [
      { field: 'subscribe_pushnoti', value: !!subscribe }
    ];

    var conditions = [
      { field: 'id', value: device_id }
    ];

    DBService.update('devices', updates, conditions)
      .then(function (result) {
        resolve(result.rows[0]);
      })
      .catch(function (err) {
        reject(err);
      });
  });
}

function setDefaultDeviceSubscribePushNoti(user, subscribe) {
  return getDevices(user)
    .then(function (devices) {
      if (devices[0].id) {
        return setSubscribePushNoti(user, devices[0].id, subscribe);
      }
    });
}

function verify(sicksenseId) {
  return DBService.update('sicksense', [
    { field: 'is_verify = $', value: 't' }
  ], [
    { field: 'id = $' , value: sicksenseId }
  ]);
}

function doesSicksenseIDExist(email) {
  return DBService.select('sicksense', '*', [
    { field: 'email = $', value: email.toLowerCase() }
  ])
  .then(function (result) {
    if (result.rows.length !== 0) {
      return when.resolve(result.rows[0]);
    }
    else {
      return when.resolve(false);
    }
  });
}
