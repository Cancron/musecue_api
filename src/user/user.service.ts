import { Injectable } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { CustomLoggerService } from '../common/services/custom-logger.service';

@Injectable()
export class UserService {
  constructor(private readonly customLogger: CustomLoggerService) {}

  create(_createUserDto: CreateUserDto) {
    this.customLogger.log('Creating new user', 'UserService');
    return 'This action adds a new user';
  }

  findAll() {
    this.customLogger.log('Fetching all users', 'UserService');
    return `This action returns all user`;
  }

  findOne(id: number) {
    this.customLogger.log(`Fetching user with id: ${id}`, 'UserService');
    return `This action returns a #${id} user`;
  }

  update(id: number, _updateUserDto: UpdateUserDto) {
    this.customLogger.log(`Updating user with id: ${id}`, 'UserService');
    return `This action updates a #${id} user`;
  }

  remove(id: number) {
    this.customLogger.warn(`Removing user with id: ${id}`, 'UserService');
    return `This action removes a #${id} user`;
  }
}
